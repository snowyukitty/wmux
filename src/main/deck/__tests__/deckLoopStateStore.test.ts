// Unit tests for the durable loop-state store (P1 contract + P2 progress file):
// round-trip, fail-open on corrupt, sanitize-on-load, progress-log cap, the
// done-contract transition, and the trusted render block.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startLoop,
  loadWorkspaceLoopState,
  loadDeckLoopState,
  appendProgress,
  setTaskPasses,
  setLoopStatus,
  setLoopScheduleId,
  clearLoop,
  isDone,
  isLoopDone,
  renderLoopStateBlock,
  getDeckLoopStatePath,
  LOOP_STATE_LIMITS,
} from '../deckLoopStateStore';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-deck-loop-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deckLoopStateStore', () => {
  it('starts a loop with a seed checklist and round-trips it', async () => {
    const s = await startLoop('ws-1', { objective: 'keep CI green', taskTexts: ['tests pass', 'lint clean'] }, dir);
    expect(s).toMatchObject({ objective: 'keep CI green', status: 'running' });
    expect(s!.tasks.map((t) => t.text)).toEqual(['tests pass', 'lint clean']);
    expect(s!.tasks.every((t) => !t.passes)).toBe(true);

    const loaded = loadWorkspaceLoopState('ws-1', dir);
    expect(loaded?.objective).toBe('keep CI green');
    // A second workspace has no loop.
    expect(loadWorkspaceLoopState('ws-2', dir)).toBeNull();
  });

  it('an empty objective is not a loop', async () => {
    expect(await startLoop('ws-1', { objective: '   ' }, dir)).toBeNull();
    expect(loadWorkspaceLoopState('ws-1', dir)).toBeNull();
  });

  it('missing / corrupt file fails open to empty (never throws)', () => {
    expect(loadWorkspaceLoopState('ws-1', dir)).toBeNull();
    fs.writeFileSync(getDeckLoopStatePath(dir), 'CORRUPT{', 'utf8');
    expect(loadWorkspaceLoopState('ws-1', dir)).toBeNull();
    expect(loadDeckLoopState(dir)).toEqual({});
  });

  it('sanitizes hand-edited entries on load (bad tasks dropped, passes coerced)', () => {
    fs.writeFileSync(
      getDeckLoopStatePath(dir),
      JSON.stringify({
        'ws-1': {
          objective: 'ship it',
          tasks: [
            { id: 't1', text: 'real task', passes: 'yes' }, // non-boolean passes → false
            { text: '', passes: true }, // empty text → dropped
            'garbage',
          ],
          progressLog: [{ ts: 5, note: 'did a thing' }, { note: '' }],
          status: 'bogus',
        },
        'bad key!': { objective: 'x' },
      }),
      'utf8',
    );
    const s = loadWorkspaceLoopState('ws-1', dir)!;
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]).toMatchObject({ text: 'real task', passes: false });
    expect(s.progressLog).toEqual([{ ts: 5, note: 'did a thing' }]);
    expect(s.status).toBe('idle'); // unknown status → idle
    expect(loadWorkspaceLoopState('bad key!', dir)).toBeNull();
  });

  it('appends progress and caps the log at the limit', async () => {
    const initial = await startLoop('ws-1', { objective: 'o' }, dir);
    const limit = LOOP_STATE_LIMITS.MAX_PROGRESS_ENTRIES;
    const seeded = Array.from({ length: limit - 1 }, (_, i) => ({ ts: i + 1, note: `note ${i}` }));
    const file = getDeckLoopStatePath(dir);
    // Seed the boundary once; hundreds of atomic writes test disk throughput,
    // not which entry survives overflow.
    fs.writeFileSync(file, JSON.stringify({ 'ws-1': { ...initial, progressLog: seeded } }));
    await appendProgress('ws-1', 'at limit', dir);
    await appendProgress('ws-1', 'over limit', dir);

    const expected = [...seeded.slice(1).map((entry) => entry.note), 'at limit', 'over limit'];
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Inspect disk as well as the sanitized view: load-time truncation must
    // not hide a writer that persists an unbounded history.
    expect(stored['ws-1'].progressLog.map((entry: { note: string }) => entry.note)).toEqual(expected);
    expect(loadWorkspaceLoopState('ws-1', dir)!.progressLog.map((entry) => entry.note)).toEqual(expected);
  });

  it('completing every task flips status to done; un-passing re-opens the loop', async () => {
    const s0 = await startLoop('ws-1', { objective: 'o', taskTexts: ['a', 'b'] }, dir);
    const [a, b] = s0!.tasks;

    const s1 = await setTaskPasses('ws-1', a.id, true, dir);
    expect(s1!.status).toBe('running'); // not all pass yet
    const s2 = await setTaskPasses('ws-1', b.id, true, dir);
    expect(s2!.status).toBe('done');
    expect(isLoopDone(s2)).toBe(true);

    // Un-pass one → loop re-opens.
    const s3 = await setTaskPasses('ws-1', b.id, false, dir);
    expect(s3!.status).toBe('running');
  });

  it('a paused loop is not auto-flipped to done', async () => {
    const s0 = await startLoop('ws-1', { objective: 'o', taskTexts: ['a'] }, dir);
    await setLoopStatus('ws-1', 'paused', dir);
    const s = await setTaskPasses('ws-1', s0!.tasks[0].id, true, dir);
    expect(s!.status).toBe('paused');
  });

  it('tier + scheduleId round-trip; tier fails closed to report on garbage', async () => {
    const s = await startLoop('ws-1', { objective: 'o', tier: 'continue', scheduleId: 'sched-9' }, dir);
    expect(s).toMatchObject({ tier: 'continue', scheduleId: 'sched-9' });
    expect(loadWorkspaceLoopState('ws-1', dir)).toMatchObject({ tier: 'continue', scheduleId: 'sched-9' });

    // Hand-edited garbage tier → 'report' (fail-closed); missing tier too.
    fs.writeFileSync(
      getDeckLoopStatePath(dir),
      JSON.stringify({
        'ws-1': { objective: 'o', tasks: [], progressLog: [], status: 'running', tier: 'full-auto' },
        'ws-2': { objective: 'o2', tasks: [], progressLog: [], status: 'running' },
      }),
      'utf8',
    );
    expect(loadWorkspaceLoopState('ws-1', dir)!.tier).toBe('report');
    expect(loadWorkspaceLoopState('ws-2', dir)!.tier).toBe('report');
  });

  it('iterations round-trip; omitted/garbage → default; out-of-range clamps on load', async () => {
    const s = await startLoop('ws-1', { objective: 'o', iterations: 40 }, dir);
    expect(s!.iterations).toBe(40);
    expect(loadWorkspaceLoopState('ws-1', dir)!.iterations).toBe(40);

    const d = await startLoop('ws-2', { objective: 'o2' }, dir);
    expect(d!.iterations).toBe(LOOP_STATE_LIMITS.DEFAULT_ITERATIONS);

    // Hand-edited garbage / out-of-range → default / clamped (never NaN).
    fs.writeFileSync(
      getDeckLoopStatePath(dir),
      JSON.stringify({
        'ws-1': { objective: 'o', tasks: [], progressLog: [], status: 'running', iterations: 'lots' },
        'ws-2': { objective: 'o', tasks: [], progressLog: [], status: 'running', iterations: 9999 },
        'ws-3': { objective: 'o', tasks: [], progressLog: [], status: 'running', iterations: 0 },
      }),
      'utf8',
    );
    expect(loadWorkspaceLoopState('ws-1', dir)!.iterations).toBe(LOOP_STATE_LIMITS.DEFAULT_ITERATIONS);
    expect(loadWorkspaceLoopState('ws-2', dir)!.iterations).toBe(LOOP_STATE_LIMITS.MAX_ITERATIONS);
    expect(loadWorkspaceLoopState('ws-3', dir)!.iterations).toBe(LOOP_STATE_LIMITS.MIN_ITERATIONS);
  });

  it('setLoopScheduleId links and unlinks the cadence schedule', async () => {
    await startLoop('ws-1', { objective: 'o' }, dir);
    const linked = await setLoopScheduleId('ws-1', 'sched-1', dir);
    expect(linked!.scheduleId).toBe('sched-1');
    const unlinked = await setLoopScheduleId('ws-1', undefined, dir);
    expect(unlinked!.scheduleId).toBeUndefined();
  });

  it('clearLoop removes the workspace entry', async () => {
    await startLoop('ws-1', { objective: 'o' }, dir);
    await clearLoop('ws-1', dir);
    expect(loadWorkspaceLoopState('ws-1', dir)).toBeNull();
  });

  it('isDone: an empty checklist is never done (runs on the objective)', () => {
    expect(isDone([])).toBe(false);
    expect(isDone([{ id: '1', text: 't', passes: true }])).toBe(true);
    expect(isDone([{ id: '1', text: 't', passes: false }])).toBe(false);
  });

  it('renders a compact trusted block with progress and a checkbox list', async () => {
    const s0 = await startLoop('ws-1', { objective: 'keep green', taskTexts: ['tests', 'lint'] }, dir);
    await setTaskPasses('ws-1', s0!.tasks[0].id, true, dir);
    await appendProgress('ws-1', 'ran the suite', dir);
    const block = renderLoopStateBlock(loadWorkspaceLoopState('ws-1', dir)!);
    expect(block).toContain('[loop]');
    expect(block).toContain('objective: keep green');
    expect(block).toContain('(1/2 passing)');
    expect(block).toContain('[x] tests');
    expect(block).toContain('[ ] lint');
    expect(block).toContain('ran the suite');
  });
});
