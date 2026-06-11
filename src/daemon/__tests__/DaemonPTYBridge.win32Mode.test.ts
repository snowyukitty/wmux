import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IPty } from 'node-pty';
import { DaemonPTYBridge } from '../DaemonPTYBridge';
import { RingBuffer } from '../RingBuffer';

/**
 * win32-input-mode (DECSET 9001) tracking — codex review finding #1.
 * The bridge is the daemon-side authority for the mode flag the renderer
 * otherwise reconstructs from ring replay (and loses to ring eviction).
 */

function makeFakePty(): { pty: IPty; emitData: (data: string) => void } {
  let dataCb: ((data: string) => void) | null = null;
  const pty = {
    onData: (cb: (data: string) => void) => {
      dataCb = cb;
      return { dispose: () => { dataCb = null; } };
    },
    onExit: () => ({ dispose: () => undefined }),
  } as unknown as IPty;
  return { pty, emitData: (data: string) => dataCb?.(data) };
}

describe('DaemonPTYBridge win32-input-mode tracking', () => {
  let bridge: DaemonPTYBridge;
  let ring: RingBuffer;
  let emitData: (data: string) => void;

  beforeEach(() => {
    bridge = new DaemonPTYBridge();
    ring = new RingBuffer(4096);
    const fake = makeFakePty();
    emitData = fake.emitData;
    bridge.setupDataForwarding(fake.pty, ring, 'test-session');
  });

  afterEach(() => {
    bridge.cleanup();
  });

  it('starts with the mode off', () => {
    expect(bridge.getWin32InputMode()).toBe(false);
  });

  it('tracks set and reset in a single chunk, last occurrence wins', () => {
    emitData('hello \x1b[?9001h world');
    expect(bridge.getWin32InputMode()).toBe(true);

    emitData('\x1b[?9001l and \x1b[?9001h again');
    expect(bridge.getWin32InputMode()).toBe(true);

    emitData('bye \x1b[?9001l');
    expect(bridge.getWin32InputMode()).toBe(false);
  });

  it('matches a toggle split across chunk boundaries', () => {
    emitData('prefix \x1b[?90');
    expect(bridge.getWin32InputMode()).toBe(false);
    emitData('01h suffix');
    expect(bridge.getWin32InputMode()).toBe(true);

    // Worst case: one byte per chunk.
    for (const ch of '\x1b[?9001l') emitData(ch);
    expect(bridge.getWin32InputMode()).toBe(false);
  });

  it('RIS (ESC c) resets the mode like every other terminal mode', () => {
    emitData('\x1b[?9001h');
    expect(bridge.getWin32InputMode()).toBe(true);
    emitData('app crashed, shell prints \x1bc reset');
    expect(bridge.getWin32InputMode()).toBe(false);
  });

  it('a stale RIS in the carry does not override a newer set', () => {
    // RIS is short enough to sit fully inside the 8-char carry; a newer
    // ?9001h in the next chunk must still win (higher index in carry+data).
    emitData('\x1bc');
    emitData('\x1b[?9001h');
    expect(bridge.getWin32InputMode()).toBe(true);
  });

  it('tracks mode changes in muted chunks (protocol state, not display bytes)', () => {
    // Muting protects the ring/renderer from geometry-mismatched DISPLAY
    // output, but a mode negotiated during that window is real protocol
    // state — the renderer can only learn about it from the attach preamble,
    // which reads this flag. (Codex round-2 finding #3.)
    bridge.setMuted(true);
    emitData('\x1b[?9001h');
    expect(bridge.getWin32InputMode()).toBe(true);
    bridge.setMuted(false);
    emitData('\x1b[?9001l');
    expect(bridge.getWin32InputMode()).toBe(false);
  });

  it('parses combined private CSI param lists like the renderer parser', () => {
    // xterm's renderer handler checks params.includes(9001), so a combined
    // set such as ESC[?2004;9001h must flip the daemon flag too — a
    // literal-token scan diverged here and the replay preamble then forced
    // the renderer WRONG. (Codex round-2 finding #4.)
    emitData('\x1b[?2004;9001h');
    expect(bridge.getWin32InputMode()).toBe(true);

    emitData('\x1b[?2004;9001l');
    expect(bridge.getWin32InputMode()).toBe(false);

    // A combined list WITHOUT 9001 must not touch the flag.
    emitData('\x1b[?9001h');
    emitData('\x1b[?2004;1049l');
    expect(bridge.getWin32InputMode()).toBe(true);
  });

  it('matches a combined param list split across chunks', () => {
    emitData('text \x1b[?2004;90');
    expect(bridge.getWin32InputMode()).toBe(false);
    emitData('01h tail');
    expect(bridge.getWin32InputMode()).toBe(true);
  });

  it('drops a pathological oversized param carry instead of growing it', () => {
    // A split sequence whose param list exceeds the 64-char carry cap is
    // abandoned (no real DECSET comes close); the flag simply keeps its
    // previous value rather than the scanner buffering unboundedly.
    emitData('\x1b[?' + '1;'.repeat(40)); // 80+ chars of params, unterminated
    emitData('9001h');
    expect(bridge.getWin32InputMode()).toBe(false);
  });

  it('resets state when forwarding is set up for a fresh PTY', () => {
    emitData('\x1b[?9001h');
    expect(bridge.getWin32InputMode()).toBe(true);

    const fresh = makeFakePty();
    bridge.setupDataForwarding(fresh.pty, new RingBuffer(4096), 'test-session-2');
    expect(bridge.getWin32InputMode()).toBe(false);
  });
});
