/**
 * Pure orchestration for "copy selection → clipboard, with success/error
 * feedback".
 *
 * Background:
 * The Electron main-process clipboard handler now throws (with codes such as
 * CLIPBOARD_TOO_LARGE / CLIPBOARD_INVALID_TYPE / CLIPBOARD_WRITE_FAILED) on
 * failure. Previously the renderer fired-and-forgot
 * `clipboardAPI.writeText()`, cleared the selection, and showed a success
 * toast — meaning failures were invisible and the user thought the copy had
 * worked. This helper awaits the write and routes success/failure to the
 * correct UI path while keeping the selection intact on error so the user
 * can retry without re-dragging.
 *
 * Kept in its own module so it can be unit-tested in vitest's default `node`
 * environment (without pulling in xterm / WebGL / DOM-dependent imports).
 */

export interface CopyWithFeedbackDeps {
  /** Bridge to `window.clipboardAPI.writeText` (or any equivalent). */
  write: (text: string) => Promise<void>;
  /**
   * Optional bridge to `window.clipboardAPI.readText`. When provided and the
   * clipboard already holds exactly the selection, the write is skipped while
   * the success UI (clearSelection/onSuccess) still runs. This dedupes the
   * "copied twice" stacking: auto-copy-on-selection has usually already
   * written the selection by the time an explicit right-click / Ctrl+C copy
   * runs, and a second identical write only piles a duplicate entry onto the
   * Windows clipboard history (Win+V) / clipboard managers. A failed read
   * falls back to writing — never the other way around.
   */
  readCurrent?: () => Promise<string>;
  /** Called on success only — selection stays put on failure for retry. */
  clearSelection: () => void;
  /** Called on success — typically shows a green "Copied!" toast. */
  onSuccess: () => void;
  /** Called on failure — typically shows a red "Copy failed" toast. */
  onError: () => void;
}

/**
 * Run the copy flow. Always resolves; never throws (it converts a thrown
 * write into the `onError` UI path).
 */
// TEMP [clipdiag]: compact preview for duplicate-copy diagnosis. Remove with
// the rest of the [clipdiag] lines once the field repro is solved.
const dbg = (text: string): string =>
  `len=${text.length} ${JSON.stringify(text.length > 24 ? text.slice(0, 24) + '…' : text)}`;

export async function runCopyWithFeedback(
  selection: string,
  deps: CopyWithFeedbackDeps,
): Promise<void> {
  try {
    if (deps.readCurrent) {
      let current: string | null = null;
      try {
        current = await deps.readCurrent();
      } catch {
        // Unreadable clipboard (image content, IPC hiccup) → just write.
        current = null;
      }
      if (current !== null && current === selection) {
        // Clipboard already holds this exact text — report success without
        // stacking a duplicate clipboard-history entry.
        // eslint-disable-next-line no-console
        console.log(`[clipdiag] explicit skip-equal ${dbg(selection)}`);
        deps.clearSelection();
        deps.onSuccess();
        return;
      }
      // eslint-disable-next-line no-console
      console.log(`[clipdiag] explicit WRITE ${dbg(selection)} clipboard-was ${current === null ? '<unreadable>' : dbg(current)}`);
    }
    await deps.write(selection);
    deps.clearSelection();
    deps.onSuccess();
  } catch {
    // Keep the selection — the user can retry the copy.
    deps.onError();
  }
}
