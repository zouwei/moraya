/**
 * Serialized wrappers around Tauri's native dialogs.
 *
 * Sixteen modules raise `ask` / `confirm` / `message` / `open` / `save`
 * independently, with nothing coordinating them. On macOS these present as
 * window-modal sheets: two on the same window at the same time deadlock — the
 * second cannot present and the first can no longer be dismissed, which the
 * user experiences as "the buttons stopped working and the app is stuck".
 *
 * The paths that can collide are not exotic. Closing a dirty tab raises the
 * unsaved-changes prompt; dismissing it hands focus back to the window, which
 * fires the focus listener, which can raise the external-change prompt. And
 * answering "Save" runs `handleSave`, which may open the native save panel
 * while the alert it was launched from is still tearing down.
 *
 * Everything here funnels through one promise chain, so a second dialog simply
 * waits its turn. File pickers are included deliberately — they are native
 * modals on the same window and deadlock exactly like the alerts do.
 *
 * In dev builds each open/close is logged with its title, which is how you tell
 * a genuine deadlock (two opens, no close) from a dialog that never fired.
 */

import {
  ask as tauriAsk,
  confirm as tauriConfirm,
  message as tauriMessage,
  open as tauriOpen,
  save as tauriSave,
} from '@tauri-apps/plugin-dialog';

type Options = { title?: string } | string | undefined;

/** Tail of the queue. Never rejects, so one failure cannot stall the rest. */
let chain: Promise<unknown> = Promise.resolve();
/** Title of the dialog currently on screen, for diagnostics. */
let openTitle: string | null = null;

function labelOf(kind: string, options: Options): string {
  const title = typeof options === 'string' ? options : options?.title;
  return title ? `${kind}:${title}` : kind;
}

function enqueue<T>(label: string, run: () => Promise<T>): Promise<T> {
  const result = chain.then(async () => {
    if (import.meta.env.DEV && openTitle) {
      console.warn(`[dialog] "${label}" queued behind "${openTitle}"`);
    }
    openTitle = label;
    if (import.meta.env.DEV) console.log(`[dialog] open  ${label}`);
    try {
      return await run();
    } finally {
      if (import.meta.env.DEV) console.log(`[dialog] close ${label}`);
      openTitle = null;
    }
  });
  chain = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function ask(...args: Parameters<typeof tauriAsk>): ReturnType<typeof tauriAsk> {
  return enqueue(labelOf('ask', args[1]), () => tauriAsk(...args));
}

export function confirm(...args: Parameters<typeof tauriConfirm>): ReturnType<typeof tauriConfirm> {
  return enqueue(labelOf('confirm', args[1]), () => tauriConfirm(...args));
}

export function message(...args: Parameters<typeof tauriMessage>): ReturnType<typeof tauriMessage> {
  return enqueue(labelOf('message', args[1]), () => tauriMessage(...args));
}

export function open(...args: Parameters<typeof tauriOpen>): ReturnType<typeof tauriOpen> {
  return enqueue(labelOf('open', args[0] as Options), () => tauriOpen(...args)) as ReturnType<
    typeof tauriOpen
  >;
}

export function save(...args: Parameters<typeof tauriSave>): ReturnType<typeof tauriSave> {
  return enqueue(labelOf('save', args[0] as Options), () => tauriSave(...args));
}

/** Title of the dialog currently on screen, or null. Diagnostics only. */
export function currentDialog(): string | null {
  return openTitle;
}
