import { describe, expect, it } from 'vitest';
import { readAgyQuota } from '../agyAdapter';

const CAPTURED = Date.parse('2026-10-01T12:00:00Z');

function readerFor(record: unknown) {
  return async (filePath: string) => (filePath.endsWith('agy.json') ? JSON.stringify(record) : null);
}

describe('readAgyQuota reset_in_seconds', () => {
  const record = {
    quotaCapturedAtMs: CAPTURED,
    quota: { 'gemini-pro': { remaining_fraction: 0.5, reset_in_seconds: 600 } },
  };

  it('anchors the reset to the capture time, so it does not move between reads', async () => {
    const first = await readAgyQuota({ homeDir: '/h', now: () => CAPTURED + 60_000, readAgyFile: readerFor(record) });
    const later = await readAgyQuota({ homeDir: '/h', now: () => CAPTURED + 300_000, readAgyFile: readerFor(record) });
    expect(first.windows[0].resetAtMs).toBe(CAPTURED + 600_000);
    expect(later.windows[0].resetAtMs).toBe(CAPTURED + 600_000);
  });

  it('does not take the countdown for the window length', async () => {
    const q = await readAgyQuota({ homeDir: '/h', now: () => CAPTURED, readAgyFile: readerFor(record) });
    expect(q.windows[0].windowMins).toBeNull();
  });

  it('leaves the reset unknown when the record has no capture time', async () => {
    const bare = { quota: record.quota };
    const q = await readAgyQuota({ homeDir: '/h', now: () => CAPTURED, readAgyFile: readerFor(bare) });
    expect(q.windows[0].resetAtMs).toBeNull();
  });
});
