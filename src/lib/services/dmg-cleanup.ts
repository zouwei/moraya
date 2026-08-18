/**
 * macOS-only self-check that detects stale `/Volumes/Moraya*` DMG mounts
 * left behind by previous installs and offers to eject them.
 *
 * Why: every DMG that's still mounted holds a `Moraya.app` whose bundle id
 * (`com.moraya.app`) matches the running app. macOS LaunchServices
 * registers all of them, so the Finder "Open With" menu sprouts one
 * Moraya entry per old version. Most users never realize they're
 * supposed to eject the DMG after installing.
 *
 * The check is harmless on cold-start (one Tauri command + at most one
 * native dialog) and self-suppresses once the user has dismissed an
 * identical set of stale mounts — see [[settingsStore.staleDmgDismissedFingerprint]].
 * Non-macOS callers are a no-op.
 */

import { invoke } from '@tauri-apps/api/core';
import { ask, message } from '$lib/utils/native-dialog';
import { isMacOS } from '$lib/utils/platform';
import { settingsStore } from '$lib/stores/settings-store';
import { get as storeGet } from 'svelte/store';
import { t as tStore } from '$lib/i18n';

interface StaleMoraya {
  app_path: string;
  mount_path: string;
  version: string;
}

/** Deterministic key for the "user already dismissed this set" suppression. */
function fingerprint(stale: StaleMoraya[]): string {
  return stale
    .map(s => s.mount_path)
    .slice()
    .sort()
    .join(',');
}

/**
 * Run the check. Caller should fire-and-forget at startup AFTER the main
 * window has rendered — this awaits Tauri IPC + (maybe) a native dialog,
 * neither of which should block the editor mount path.
 */
export async function maybePromptStaleDmgCleanup(): Promise<void> {
  if (!isMacOS) return;

  let stale: StaleMoraya[];
  try {
    stale = await invoke<StaleMoraya[]>('find_stale_moraya_mounts');
  } catch {
    return; // command not registered (dev build, non-macOS, etc.) — silent.
  }
  if (stale.length === 0) return;

  const fp = fingerprint(stale);
  const dismissedFp = storeGet(settingsStore).staleDmgDismissedFingerprint;
  // Only stay silent if the dismissed set is a SUPERSET of (or equal to)
  // what we found now. If a NEW stale DMG appeared since dismissal we
  // re-prompt — the dismissal was about a specific situation, not
  // a permanent "never again."
  if (dismissedFp) {
    const dismissed = new Set(dismissedFp.split(','));
    const allDismissed = stale.every(s => dismissed.has(s.mount_path));
    if (allDismissed) return;
  }

  const t = storeGet(tStore);
  const list = stale
    .map(s => `  • Moraya ${s.version || '?'}  (${s.mount_path})`)
    .join('\n');

  const proceed = await ask(
    `${t('stale_dmg.body')}\n\n${list}`,
    {
      title: t('stale_dmg.title'),
      kind: 'info',
      okLabel: t('stale_dmg.eject_all'),
      cancelLabel: t('stale_dmg.skip'),
    },
  );

  if (!proceed) {
    // Remember the dismissal so we don't pester them every launch — but
    // record the fingerprint so a NEW stale mount can re-prompt later.
    settingsStore.update({ staleDmgDismissedFingerprint: fp });
    return;
  }

  // Eject sequentially. Detaching is fast; doing it in parallel risks
  // hdiutil race conditions on the same volume table.
  const failures: { path: string; reason: string }[] = [];
  for (const s of stale) {
    try {
      await invoke('eject_dmg_mount', { path: s.mount_path });
    } catch (e) {
      failures.push({ path: s.mount_path, reason: String(e) });
    }
  }

  if (failures.length > 0) {
    const lines = failures.map(f => `  • ${f.path}\n    ${f.reason}`).join('\n');
    await message(`${t('stale_dmg.partial_failure')}\n\n${lines}`, {
      title: t('stale_dmg.title'),
      kind: 'warning',
    });
    // Don't store dismissal — we want to retry next launch.
    return;
  }

  // Clean run — clear any stale fingerprint so a future regression
  // (user re-downloads an old DMG) prompts again.
  settingsStore.update({ staleDmgDismissedFingerprint: null });
}
