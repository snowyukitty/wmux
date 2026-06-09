/**
 * Tests for the deterministic newline-key encoder.
 *
 * Regression target: Ctrl+J silently dropped under a CJK IME. xterm.js derives
 * Ctrl+<letter> from the deprecated `keyCode`, which becomes 229 ("Process")
 * with the IME active, so Ctrl+J never produced an LF and in-pane TUIs (codex,
 * Claude Code) never saw the newline. The encoder matches the physical `code`
 * so the byte is emitted regardless of IME/layout state.
 */
import { describe, it, expect } from 'vitest';
import { resolveNewlineKeyByte, type NewlineKeyEventLike } from '../newlineKeys';

function ev(partial: Partial<NewlineKeyEventLike>): NewlineKeyEventLike {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    ...partial,
  };
}

describe('resolveNewlineKeyByte — Ctrl+J', () => {
  it('emits LF for Ctrl+J via physical code (Latin layout)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }))).toBe('\n');
  });

  it('emits LF for Ctrl+J even when an IME mangles key to "Process"', () => {
    // keyCode would be 229 here; we never look at it. code stays 'KeyJ'.
    expect(resolveNewlineKeyByte(ev({ key: 'Process', code: 'KeyJ', ctrlKey: true }))).toBe('\n');
  });

  it('ignores Ctrl+Shift+J (reserved for app shortcuts)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it('ignores Ctrl+Alt+J and Ctrl+Meta+J', () => {
    expect(resolveNewlineKeyByte(ev({ code: 'KeyJ', ctrlKey: true, altKey: true }))).toBeNull();
    expect(resolveNewlineKeyByte(ev({ code: 'KeyJ', ctrlKey: true, metaKey: true }))).toBeNull();
  });

  it('ignores a bare J (no Ctrl)', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ' }))).toBeNull();
  });

  it('defers during an active IME composition (isComposing) so preedit is not split', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Process', code: 'KeyJ', ctrlKey: true, isComposing: true })),
    ).toBeNull();
  });

  it('defers to an explicit user Ctrl+J keybinding', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), { hasCustomCtrlJBinding: true }),
    ).toBe(null);
  });

  it('still emits LF when opts is present but no Ctrl+J binding', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), { hasCustomCtrlJBinding: false }),
    ).toBe('\n');
  });
});

describe('resolveNewlineKeyByte — Shift+Enter (preserved behavior)', () => {
  it('emits CSI u for Shift+Enter', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }))).toBe('\x1b[13;2u');
  });

  it('ignores plain Enter', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter' }))).toBeNull();
  });

  it('ignores Ctrl+Shift+Enter', () => {
    expect(resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBeNull();
  });
});

describe('resolveNewlineKeyByte — win32-input-mode (DECSET 9001 active)', () => {
  // A crossterm TUI (codex 0.137) ignores raw LF and the kitty CSI-u once it
  // has turned on win32-input-mode; only the matching win32 input record
  // (key-down + key-up) inserts a newline. Verified against real codex via a
  // headless xterm v6 harness.
  const WIN32_CTRL_J = '\x1b[74;36;10;1;8;1_\x1b[74;36;10;0;8;1_';
  const WIN32_SHIFT_ENTER = '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_';

  it('emits the win32 Ctrl+J record instead of LF when the mode is active', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), { win32InputMode: true }),
    ).toBe(WIN32_CTRL_J);
  });

  it('emits the win32 Shift+Enter record instead of CSI u when the mode is active', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), { win32InputMode: true }),
    ).toBe(WIN32_SHIFT_ENTER);
  });

  it('falls back to LF / CSI u when the mode is inactive', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), { win32InputMode: false }),
    ).toBe('\n');
    expect(
      resolveNewlineKeyByte(ev({ key: 'Enter', shiftKey: true }), { win32InputMode: false }),
    ).toBe('\x1b[13;2u');
  });

  it('still respects the custom-binding guard under win32 mode', () => {
    expect(
      resolveNewlineKeyByte(ev({ key: 'j', code: 'KeyJ', ctrlKey: true }), {
        win32InputMode: true,
        hasCustomCtrlJBinding: true,
      }),
    ).toBeNull();
  });
});
