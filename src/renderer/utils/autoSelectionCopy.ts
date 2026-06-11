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
   * onSelectionChange whenever the buffer repaints or scrolls under it — a
   * constantly redrawing TUI pane re-armed this debounce forever, stacking
   * the same text into the Windows clipboard history (Win+V) on every
   * repaint. Re-selecting the same word had the same effect. A failed read
   * falls back to writing — never the other way around.
   */
  readCurrent?: () => Promise<string>;
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
  /** Cancel any pending debounced write. Call on unmount. */
  dispose: () => void;
}

const DEFAULT_DEBOUNCE_MS = 150;

export function createAutoSelectionCopy(deps: AutoSelectionCopyDeps): AutoSelectionCopyHandle {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));

  let pending: ReturnType<typeof setTimeout> | null = null;

  const onSelection = (selection: string): void => {
    if (pending) clearT(pending);
    pending = setT(() => {
      pending = null;
      if (!selection || selection.length === 0) return;
      void (async () => {
        if (deps.readCurrent) {
          try {
            if ((await deps.readCurrent()) === selection) return;
          } catch {
            // Unreadable clipboard (image content, IPC hiccup) → just write.
          }
        }
        await deps.write(selection);
      })().catch(() => {
        // Silent — explicit copy paths still surface errors when retried.
      });
    }, debounceMs);
  };

  const dispose = (): void => {
    if (pending) {
      clearT(pending);
      pending = null;
    }
  };

  return { onSelection, dispose };
}
