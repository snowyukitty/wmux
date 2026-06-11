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

  it('does not track muted chunks (they never reach the ring or renderer)', () => {
    bridge.setMuted(true);
    emitData('\x1b[?9001h');
    expect(bridge.getWin32InputMode()).toBe(false);
    bridge.setMuted(false);
    emitData('\x1b[?9001h');
    expect(bridge.getWin32InputMode()).toBe(true);
  });

  it('resets state when forwarding is set up for a fresh PTY', () => {
    emitData('\x1b[?9001h');
    expect(bridge.getWin32InputMode()).toBe(true);

    const fresh = makeFakePty();
    bridge.setupDataForwarding(fresh.pty, new RingBuffer(4096), 'test-session-2');
    expect(bridge.getWin32InputMode()).toBe(false);
  });
});
