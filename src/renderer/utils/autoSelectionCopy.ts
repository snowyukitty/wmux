/**
 * Debounced auto-copy on terminal selection change.
 *
 * Background:
 * Terminal `onSelectionChange` fires once per cell during a drag — for a
 * 50-char selection that's 50 IPC writes if we copy on every event. We
 * debounce so only the final selection (after the user releases) reaches
 * the clipboard. Empty selections are ignored (clearing a selection should
 * not clobber whatever the user had on the clipboard before).
 *
 * Failures are silent here — the explicit Ctrl+C / right-click paths still
 * surface clipboard errors via their own toast when the user retries.
 *
 * Extracted from useTerminal.ts so the timing + filtering logic can be
 * unit-tested without pulling in xterm + Electron + DOM.
 */

export interface AutoSelectionCopyDeps {
  /** Bridge to `window.clipboardAPI.writeText` (or any equivalent). */
  write: (text: string) => Promise<unknown>;
  /**
   * Optional bridge to `window.clipboardAPI.readText`. When provided and the
   * clipboard already holds exactly the selection, the debounced write is
   * skipped. This is the auto-copy half of the duplicate-entry fix: a kept
   * selection (right-click copy uses keepSelection) re-fires
   * onSelectionChange when the buffer shifts under it (scroll, trim — xterm
   * fires on selection-coordinate change, not on paint alone), and
   * re-selecting the same text fires it again outright. Each re-fire
   * re-armed this debounce and rewrote the same text, stacking duplicate
   * entries into the Windows clipboard history (Win+V). A failed read falls
   * back to writing — never the other way around.
   */
  readCurrent?: () => Promise<string>;
  /**
   * Optional bridge to `terminal.getSelection()`. When provided, the debounced
   * write re-reads the live selection as it fires and bails if the text no
   * longer matches what was captured. This is the transient-capture guard for
   * live TUI panes (Claude Code/Ink redraws erase-then-rewrite the region
   * under a kept selection): an onSelectionChange that lands mid-repaint
   * captures a partial/blank line, and without this check that garbage went
   * to the clipboard 150ms later — then the next capture of the full text
   * wrote AGAIN, stacking lookalike duplicates into Win+V. Requiring the
   * same text at capture time and fire time filters repaint transients;
   * a newer capture re-arms the debounce and owns the write.
   */
  getCurrent?: () => string;
  /**
   * Optional gesture gate. When provided, onSelection events are ignored
   * outside a live user selection gesture (mouse down → shortly after
   * release). This is what stops the buffer-shift storm: an in-pane TUI
   * streaming to the MAIN buffer (Claude Code) trims a line for every line
   * it emits once scrollback is full, dragging a kept selection's
   * coordinates until its start row falls off — at which point the
   * selection TEXT genuinely changes and every equality-based dedupe
   * correctly lets the truncated text through as a brand-new write
   * ("continuous copies"). Those events are not user selections and must
   * not re-arm the debounce at all. Gated events also must not cancel a
   * pending write from the real gesture, so the gate is checked first.
   * (Alt-screen TUIs like codex never trim the main buffer under a
   * selection, which is why they never exhibited the bug.)
   */
  accept?: () => boolean;
  /** Debounce window in ms. Defaults to 150. */
  debounceMs?: number;
  /**
   * Optional override for setTimeout/clearTimeout — used by tests with
   * vitest's `vi.useFakeTimers()`. Defaults to globalThis.
   */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface AutoSelectionCopyHandle {
  /** Call from the terminal's onSelectionChange callback. */
  onSelection: (selection: string) => void;
  /**
   * Cancel any pending debounced write AND invalidate a write whose
   * `readCurrent()` is already in flight. The explicit copy paths call this
   * before writing so theirs is the single authoritative write — without the
   * in-flight half, an explicit copy landing during the auto-copy's clipboard
   * read made both sides see the stale clipboard and both write, recreating
   * the duplicate Win+V entry. The handle stays usable: a later onSelection
   * re-arms it. Also call on unmount.
   */
  dispose: () => void;
}

const DEFAULT_DEBOUNCE_MS = 150;

export function createAutoSelectionCopy(deps: AutoSelectionCopyDeps): AutoSelectionCopyHandle {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let pending: ReturnType<typeof setTimeout> | null = null;
  // Bumped by dispose(). An async write captures the value at debounce-fire
  // time and aborts after each await if it changed — clearTimeout alone can't
  // stop a callback that is already parked on the readCurrent() IPC.
  let epoch = 0;

  // TEMP [clipdiag]: compact preview for duplicate-copy diagnosis. Remove
  // with the rest of the [clipdiag] lines once the field repro is solved.
  const dbg = (text: string): string =>
    `len=${text.length} ${JSON.stringify(text.length > 24 ? text.slice(0, 24) + '…' : text)}`;

  const onSelection = (selection: string): void => {
    // Gesture gate FIRST: a gated (non-gesture) event must neither arm the
    // debounce nor cancel a pending write from the real gesture.
    if (deps.accept && !deps.accept()) {
      // eslint-disable-next-line no-console
      console.log(`[clipdiag] auto gate-reject ${dbg(selection)}`);
      return;
    }
    if (pending) clearT(pending);
    // eslint-disable-next-line no-console
    console.log(`[clipdiag] auto arm ${dbg(selection)}`);
    pending = setT(() => {
      pending = null;
      if (!selection || selection.length === 0) return;
      // Transient-capture guard: only write a selection that is still the
      // same text now that the debounce has fired. See getCurrent docs.
      if (deps.getCurrent) {
        const live = deps.getCurrent();
        if (live !== selection) {
          // eslint-disable-next-line no-console
          console.log(`[clipdiag] auto skip-transient captured ${dbg(selection)} live ${dbg(live)}`);
          return;
        }
      }
      const myEpoch = epoch;
      void (async () => {
        if (deps.readCurrent) {
          let current: string | null = null;
          try {
            current = await deps.readCurrent();
          } catch {
            // Unreadable clipboard (image content, IPC hiccup) → just write.
          }
          if (myEpoch !== epoch) {
            // eslint-disable-next-line no-console
            console.log(`[clipdiag] auto skip-epoch ${dbg(selection)}`);
            return; // cancelled while reading
          }
          if (current !== null && current === selection) {
            // eslint-disable-next-line no-console
            console.log(`[clipdiag] auto skip-equal ${dbg(selection)}`);
            return;
          }
          // eslint-disable-next-line no-console
          console.log(`[clipdiag] auto WRITE ${dbg(selection)} clipboard-was ${current === null ? '<unreadable>' : dbg(current)}`);
        }
        await deps.write(selection);
      })().catch(() => {
        // Silent — explicit copy paths still surface errors when retried.
      });
    }, debounceMs);
  };

  const dispose = (): void => {
    epoch++;
    if (pending) {
      clearT(pending);
      pending = null;
    }
  };

  return { onSelection, dispose };
}
