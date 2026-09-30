/**
 * Autosave scheduling (v1.21.0) — dual-condition model replacing the old
 * fixed 30-second interval:
 *
 *  1. Max-interval: pending edits are force-saved at most `maxSeconds` after
 *     they began, even while the user keeps typing.
 *  2. Idle: pending edits are saved once the user has paused input for
 *     `idleSeconds`.
 *
 * Pure decision function — the caller owns the timestamps (a coarse ticker
 * polls this every ~15s, so trigger precision is ± one tick).
 */

/**
 * Edit-activity clock.
 *
 * `lastEditAt` cannot be derived from the editor store. `markDirty()` returns
 * the SAME state object once a document is already dirty — deliberately, so a
 * keystroke does not push a notification through every subscriber (the store
 * cascade rule in AGENTS.md). Subscribers therefore never hear about the
 * second and later keystrokes, and in visual-only mode `content` does not
 * change either, since that editor skips per-keystroke serialization.
 *
 * The result was an idle timer measured from the FIRST edit: "save once input
 * pauses for N minutes" behaved as "save N minutes after you start typing",
 * firing while the user was still going.
 *
 * A module-level timestamp costs one assignment per keystroke and notifies
 * nobody, which is exactly why markDirty avoids the store in the first place.
 */
let editClock = 0;

/** Record that the document just changed. Called from the editors' change hooks. */
export function noteEdit(at: number = Date.now()): void {
  editClock = at;
}

/** Epoch ms of the most recent edit, or 0 if there has been none. */
export function lastEditTime(): number {
  return editClock;
}

/** Clear the clock — new document, or tests. */
export function resetEditClock(): void {
  editClock = 0;
}

/**
 * Both intervals are in SECONDS.
 *
 * They were minutes until issue #91: the floor of one minute is a long time to
 * wait when you are collaborating with an external tool over the same file,
 * and a minutes box cannot express "every 10 seconds" without fractions.
 * Seconds are the unit people actually reach for here, and they round-trip
 * through a number input without float noise.
 */
export interface AutoSaveTiming {
  /** Force-save pending edits at most this many seconds after they began. */
  maxSeconds: number;
  /** Save once input has paused for this many seconds. */
  idleSeconds: number;
}

/** Accepted range for the max-interval setting, in seconds. */
export const AUTOSAVE_MAX_RANGE = { min: 5, max: 7200 } as const;
/** Accepted range for the idle-delay setting, in seconds. */
export const AUTOSAVE_IDLE_RANGE = { min: 2, max: 3600 } as const;

/**
 * How often to poll `shouldAutoSave`.
 *
 * A fixed 15s tick was fine while the shortest interval was a minute; it
 * cannot honour a 5-second setting at all. The poll now tracks the shorter of
 * the two intervals — a third of it, so the trigger lands within ~33% of what
 * was asked for — and stays bounded: never faster than 1s (the work per tick
 * is a handful of arithmetic, but there is no reason to spin), never slower
 * than the original 15s.
 */
export function autoSaveTickMs(timing: AutoSaveTiming): number {
  const shortest = Math.min(timing.maxSeconds, timing.idleSeconds);
  return Math.min(15_000, Math.max(1_000, Math.round((shortest * 1000) / 3)));
}

/**
 * @param now            current epoch ms
 * @param pendingSince   epoch ms when the first unsaved edit occurred (0 = no pending edits)
 * @param lastEditAt     epoch ms of the most recent edit (0 = unknown)
 */
export function shouldAutoSave(
  now: number,
  pendingSince: number,
  lastEditAt: number,
  timing: AutoSaveTiming
): boolean {
  if (pendingSince <= 0) return false;
  // Clamped to the setting's own floor rather than to 0: a stored value of 0
  // (a hand-edited settings file, a failed migration) would otherwise mean
  // "save on every tick", which is the one behaviour nobody asked for.
  const maxMs = Math.max(AUTOSAVE_MAX_RANGE.min, timing.maxSeconds) * 1000;
  const idleMs = Math.max(AUTOSAVE_IDLE_RANGE.min, timing.idleSeconds) * 1000;
  if (now - pendingSince >= maxMs) return true;
  if (lastEditAt > 0 && now - lastEditAt >= idleMs) return true;
  return false;
}
