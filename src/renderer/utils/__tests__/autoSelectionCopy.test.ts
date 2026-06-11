import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAutoSelectionCopy } from '../autoSelectionCopy';

describe('createAutoSelectionCopy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the latest selection after the debounce window', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 100 });

    handle.onSelection('hello');

    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('coalesces rapid selection changes into a single write', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 100 });

    // Simulate the per-cell storm during a drag.
    handle.onSelection('h');
    vi.advanceTimersByTime(20);
    handle.onSelection('he');
    vi.advanceTimersByTime(20);
    handle.onSelection('hel');
    vi.advanceTimersByTime(20);
    handle.onSelection('hell');
    vi.advanceTimersByTime(20);
    handle.onSelection('hello');

    expect(write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('hello');
  });

  it('ignores empty selections (clearing should not clobber clipboard)', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 50 });

    handle.onSelection('');
    vi.advanceTimersByTime(50);

    expect(write).not.toHaveBeenCalled();
  });

  it('replaces a pending non-empty write when the selection clears mid-debounce', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 100 });

    handle.onSelection('hello');
    vi.advanceTimersByTime(50);
    // User clicks elsewhere before debounce fires — selection clears.
    handle.onSelection('');
    vi.advanceTimersByTime(100);

    // The previous write was canceled and the empty selection bailed.
    expect(write).not.toHaveBeenCalled();
  });

  it('swallows write errors silently (explicit copy path handles toasts)', async () => {
    const write = vi.fn().mockRejectedValue(new Error('CLIPBOARD_WRITE_FAILED'));
    const handle = createAutoSelectionCopy({ write, debounceMs: 50 });

    handle.onSelection('hello');
    vi.advanceTimersByTime(50);

    // Pump microtasks so the .catch() runs without an unhandled rejection.
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(1);
    // No throw observed — failure is silent.
  });

  it('dispose() cancels pending writes', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 100 });

    handle.onSelection('hello');
    vi.advanceTimersByTime(50);
    handle.dispose();
    vi.advanceTimersByTime(100);

    expect(write).not.toHaveBeenCalled();
  });

  it('dispose() is safe to call multiple times', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write });

    expect(() => {
      handle.dispose();
      handle.dispose();
    }).not.toThrow();
  });

  it('uses the default 150ms debounce when none specified', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write });

    handle.onSelection('x');
    vi.advanceTimersByTime(149);
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a selection that arrives after dispose() is honored (handle is reusable)', () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const handle = createAutoSelectionCopy({ write, debounceMs: 50 });

    handle.dispose();
    handle.onSelection('reborn');
    vi.advanceTimersByTime(50);

    expect(write).toHaveBeenCalledWith('reborn');
  });

  describe('duplicate-write dedupe (readCurrent)', () => {
    it('skips the write when the clipboard already holds the selection', async () => {
      const write = vi.fn().mockResolvedValue(undefined);
      const readCurrent = vi.fn(async () => 'same text');
      const handle = createAutoSelectionCopy({ write, readCurrent, debounceMs: 50 });

      handle.onSelection('same text');
      await vi.advanceTimersByTimeAsync(50);

      expect(readCurrent).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
    });

    it('writes when the clipboard holds different text', async () => {
      const write = vi.fn().mockResolvedValue(undefined);
      const readCurrent = vi.fn(async () => 'something else');
      const handle = createAutoSelectionCopy({ write, readCurrent, debounceMs: 50 });

      handle.onSelection('selection');
      await vi.advanceTimersByTimeAsync(50);

      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('selection');
    });

    it('a re-fire of the same kept selection writes only once', async () => {
      // The bug: right-click copy keeps the selection highlighted; when the
      // buffer shifts under it (scroll/trim — xterm fires onSelectionChange
      // on coordinate change) or the user re-selects the same text, the
      // event re-fires with identical text. Each re-fire used to write
      // again — duplicate Win+V entry.
      let clipboard = '';
      const write = vi.fn(async (text: string) => { clipboard = text; });
      const readCurrent = vi.fn(async () => clipboard);
      const handle = createAutoSelectionCopy({ write, readCurrent, debounceMs: 50 });

      handle.onSelection('held selection');
      await vi.advanceTimersByTimeAsync(50);
      expect(write).toHaveBeenCalledTimes(1);

      // TUI repaints re-fire the unchanged selection.
      handle.onSelection('held selection');
      await vi.advanceTimersByTimeAsync(50);
      handle.onSelection('held selection');
      await vi.advanceTimersByTimeAsync(50);

      expect(write).toHaveBeenCalledTimes(1);
    });

    it('falls back to writing when readCurrent rejects', async () => {
      const write = vi.fn().mockResolvedValue(undefined);
      const readCurrent = vi.fn(async () => { throw new Error('CLIPBOARD_READ_FAILED'); });
      const handle = createAutoSelectionCopy({ write, readCurrent, debounceMs: 50 });

      handle.onSelection('selection');
      await vi.advanceTimersByTimeAsync(50);

      expect(write).toHaveBeenCalledTimes(1);
    });

    it('skips a transient capture whose selection changed before the debounce fired', async () => {
      // Live TUI panes (Claude Code/Ink) erase-then-rewrite the region under
      // a kept selection. A capture landing mid-repaint holds partial text;
      // it must never reach the clipboard. getCurrent (the live selection)
      // is re-read at fire time and the write is skipped on mismatch.
      const write = vi.fn().mockResolvedValue(undefined);
      const readCurrent = vi.fn(async () => '');
      let liveSelection = 'full response text';
      const getCurrent = vi.fn(() => liveSelection);
      const handle = createAutoSelectionCopy({ write, readCurrent, getCurrent, debounceMs: 50 });

      // Mid-repaint capture: the event delivered partial text, but by fire
      // time the live selection holds the full rewrite.
      handle.onSelection('full resp');
      await vi.advanceTimersByTimeAsync(50);
      expect(write).not.toHaveBeenCalled();

      // A stable capture (event text === live text at fire time) writes.
      handle.onSelection('full response text');
      await vi.advanceTimersByTimeAsync(50);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('full response text');

      // And a capture that was full at event time but blanked by a repaint
      // at fire time is also skipped.
      liveSelection = '';
      handle.onSelection('full response text');
      await vi.advanceTimersByTimeAsync(50);
      expect(write).toHaveBeenCalledTimes(1);
    });

    it('dispose() during an in-flight readCurrent cancels the write', async () => {
      // The race (codex review finding #4): once the debounce callback has
      // entered `await readCurrent()`, clearTimeout can no longer stop it.
      // An explicit copy landing in that window calls dispose(); without
      // epoch invalidation both sides saw the stale clipboard and both
      // wrote — recreating the duplicate Win+V entry.
      let resolveRead!: (text: string) => void;
      const write = vi.fn().mockResolvedValue(undefined);
      const readCurrent = vi.fn(
        () => new Promise<string>((resolve) => { resolveRead = resolve; }),
      );
      const handle = createAutoSelectionCopy({ write, readCurrent, debounceMs: 50 });

      handle.onSelection('contested text');
      await vi.advanceTimersByTimeAsync(50);
      expect(readCurrent).toHaveBeenCalledTimes(1); // parked on the read

      // Explicit copy takes over while the read is in flight.
      handle.dispose();
      resolveRead('old clipboard'); // read resolves with non-matching text…
      await vi.runAllTimersAsync();

      // …but the cancelled epoch must not write anyway.
      expect(write).not.toHaveBeenCalled();
    });

    it('a write whose readCurrent was in flight survives an unrelated later selection', async () => {
      // Sanity check of the epoch scope: dispose() invalidates, but a fresh
      // onSelection after dispose re-arms with the new epoch and writes.
      let resolveRead!: (text: string) => void;
      const write = vi.fn().mockResolvedValue(undefined);
      const readCurrent = vi.fn(
        () => new Promise<string>((resolve) => { resolveRead = resolve; }),
      );
      const handle = createAutoSelectionCopy({ write, readCurrent, debounceMs: 50 });

      handle.onSelection('first');
      await vi.advanceTimersByTimeAsync(50);
      handle.dispose();
      resolveRead('whatever');
      await vi.runAllTimersAsync();
      expect(write).not.toHaveBeenCalled();

      handle.onSelection('second');
      await vi.advanceTimersByTimeAsync(50);
      resolveRead('not-second');
      await vi.runAllTimersAsync();

      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith('second');
    });

    it('still swallows a write error after a non-matching read', async () => {
      const write = vi.fn().mockRejectedValue(new Error('CLIPBOARD_WRITE_FAILED'));
      const readCurrent = vi.fn(async () => 'other');
      const handle = createAutoSelectionCopy({ write, readCurrent, debounceMs: 50 });

      handle.onSelection('selection');
      await vi.advanceTimersByTimeAsync(50);
      await vi.runAllTimersAsync();

      expect(write).toHaveBeenCalledTimes(1);
      // No throw observed — failure is silent.
    });
  });
});
