import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The property under test: two native dialogs are never on screen together.
 *
 * macOS presents ask/confirm/open/save as window-modal sheets. Two at once on
 * the same window deadlock — the second cannot present and the first can no
 * longer be dismissed, which reads to the user as "the buttons stopped working
 * and the app is stuck". Sixteen modules raised these independently with
 * nothing coordinating them.
 */

/** Number of dialogs the fake believes are on screen at once. */
let concurrent = 0;
let peak = 0;
const order: string[] = [];

/** Resolves after `ms`, tracking overlap while it is "open". */
async function fakeDialog(label: string, ms: number) {
  concurrent++;
  peak = Math.max(peak, concurrent);
  order.push(`open:${label}`);
  await new Promise(r => setTimeout(r, ms));
  order.push(`close:${label}`);
  concurrent--;
  return label;
}

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn((msg: string) => fakeDialog(msg, 20)),
  confirm: vi.fn((msg: string) => fakeDialog(msg, 20)),
  message: vi.fn((msg: string) => fakeDialog(msg, 20)),
  open: vi.fn(() => fakeDialog('open', 20)),
  save: vi.fn(() => fakeDialog('save', 20)),
}));

const { ask, confirm, message, open, save, currentDialog } = await import('./native-dialog');

beforeEach(() => { concurrent = 0; peak = 0; order.length = 0; });

describe('native dialog queue', () => {
  it('never runs two dialogs at once', async () => {
    await Promise.all([ask('a'), ask('b'), ask('c')]);
    expect(peak).toBe(1);
  });

  it('serializes across every dialog kind', async () => {
    // The real collision is cross-kind: an unsaved-changes alert answered with
    // "Save" opens the native save panel while the alert is still tearing down.
    await Promise.all([ask('alert'), save({}), open({}), message('m'), confirm('c')]);
    expect(peak).toBe(1);
  });

  it('runs them in the order they were requested', async () => {
    await Promise.all([ask('first'), ask('second')]);
    expect(order).toEqual(['open:first', 'close:first', 'open:second', 'close:second']);
  });

  it('returns each caller its own result', async () => {
    const [a, b] = await Promise.all([ask('a'), ask('b')]);
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('keeps the queue moving when one dialog rejects', async () => {
    const dialog = await import('@tauri-apps/plugin-dialog');
    vi.mocked(dialog.ask).mockRejectedValueOnce(new Error('boom'));
    const failed = ask('bad').catch((e: Error) => e.message);
    const after = ask('good');
    expect(await failed).toBe('boom');
    expect(await after).toBe('good');
  });

  it('reports nothing open once the queue drains', async () => {
    await ask('x');
    expect(currentDialog()).toBeNull();
  });
});
