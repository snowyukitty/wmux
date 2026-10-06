// ─── Command Deck — orchestrator schedule store (P3d) ────────────────────────
//
// Persists the orchestrator's scheduled prompts across app restarts and OS
// reboots: "check my PRs every morning" must survive a reboot to be worth
// anything. One JSON file in the wmux data dir (`deck-schedules.json`),
// written with the daemon's atomic-write primitives and honoring
// WMUX_DATA_SUFFIX isolation — the same pattern as deck-commander.json.
//
// The handoff sketched a DAEMON-side store; this is deliberately a data-dir
// file instead: firing a schedule requires the brain, and the brain lives in
// the Electron main process — a daemon store would add an RPC surface without
// letting anything fire while the app is closed. The file gives the same
// reboot survival with zero new pipe surface. Revisit if the brain ever moves
// daemon-side (unattended supervisor epic).
//
// Store is a pure CRUD + query module; the tick loop lives in DeckScheduler.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { createSerialChain } from './serialChain';

export interface DeckSchedule {
  id: string;
  /** The workspace whose orchestrator fires this schedule (M1.5 — one
   *  orchestrator per workspace, so an unowned turn cannot exist). Absent on
   *  pre-M1.5 entries: those are force-disabled on load and never fire until
   *  the operator re-scopes them to a workspace in the panel. */
  workspaceId?: string;
  /** What to tell the orchestrator when the schedule fires. */
  prompt: string;
  /** Next fire time (ms epoch). */
  nextRunAt: number;
  /** Repeat interval in minutes; absent/0 = one-shot. */
  intervalMinutes?: number;
  /** Disabled schedules are kept (visible + re-enable-able) but never fire.
   *  A fired one-shot flips to disabled instead of vanishing. */
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  /** Outcome of the last fire: accepted, rejected busy (still due — the
   *  scheduler retries), or errored. */
  lastResult?: 'ok' | 'busy' | 'error';
}

const MAX_SCHEDULES = 50;
const MAX_PROMPT_CHARS = 4000;

export function getDeckSchedulesPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'deck-schedules.json');
}

function sanitize(raw: unknown): DeckSchedule | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) return null;
  if (typeof o.nextRunAt !== 'number' || !Number.isFinite(o.nextRunAt)) return null;
  const workspaceId =
    typeof o.workspaceId === 'string' && o.workspaceId.length > 0 ? o.workspaceId : undefined;
  const s: DeckSchedule = {
    id: o.id,
    ...(workspaceId ? { workspaceId } : {}),
    prompt: o.prompt.slice(0, MAX_PROMPT_CHARS),
    nextRunAt: o.nextRunAt,
    // A schedule with no workspace has no orchestrator to run on (pre-M1.5
    // entry) — force-disabled until the operator re-scopes it.
    enabled: o.enabled === true && !!workspaceId,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
  };
  if (typeof o.intervalMinutes === 'number' && o.intervalMinutes > 0) {
    s.intervalMinutes = Math.floor(o.intervalMinutes);
  }
  if (typeof o.lastRunAt === 'number') s.lastRunAt = o.lastRunAt;
  if (o.lastResult === 'ok' || o.lastResult === 'busy' || o.lastResult === 'error') {
    s.lastResult = o.lastResult;
  }
  return s;
}

/** Load all schedules; a missing/corrupt file is an empty list (fail open to
 *  empty — a torn store must never brick the deck). */
export function loadDeckSchedules(dir?: string): DeckSchedule[] {
  let raw: unknown;
  try {
    raw = atomicReadJSONSync<unknown>(getDeckSchedulesPath(dir));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitize).filter((s): s is DeckSchedule => s !== null);
}

const serialize = createSerialChain();

/** Read-modify-write deck-schedules.json on one chain: `fn` gets the current
 *  list and returns the list to write, or null to write nothing. Every writer
 *  (handlers, scheduler, workspace teardown) goes through here so none can
 *  drop another's change. `fn` must not call back into this store's writers. */
export function mutateDeckSchedules(
  fn: (current: DeckSchedule[]) => DeckSchedule[] | null,
  dir?: string,
): Promise<void> {
  return serialize(async () => {
    const next = fn(loadDeckSchedules(dir));
    if (next) await atomicWriteJSON(getDeckSchedulesPath(dir), next);
  });
}

export async function saveDeckSchedules(schedules: DeckSchedule[], dir?: string): Promise<void> {
  await mutateDeckSchedules(() => schedules, dir);
}

/** Validated create — returns null on a bad request (empty prompt, missing
 *  workspace; a past-only one-shot is allowed: it fires on the next tick).
 *  Caller persists. */
export function createSchedule(args: {
  workspaceId: string;
  prompt: string;
  nextRunAt: number;
  intervalMinutes?: number;
}): DeckSchedule | null {
  const prompt = args.prompt.trim();
  if (!prompt) return null;
  if (!args.workspaceId) return null;
  if (!Number.isFinite(args.nextRunAt)) return null;
  const s: DeckSchedule = {
    id: randomUUID(),
    workspaceId: args.workspaceId,
    prompt: prompt.slice(0, MAX_PROMPT_CHARS),
    nextRunAt: args.nextRunAt,
    enabled: true,
    createdAt: Date.now(),
  };
  if (typeof args.intervalMinutes === 'number' && args.intervalMinutes > 0) {
    s.intervalMinutes = Math.floor(args.intervalMinutes);
  }
  return s;
}

export const DECK_SCHEDULE_LIMITS = { MAX_SCHEDULES, MAX_PROMPT_CHARS } as const;

/** Due = enabled, workspace-scoped, and past its fire time. The workspace
 *  check is a belt over sanitize's force-disable: an unowned turn never fires. */
export function dueSchedules(schedules: DeckSchedule[], now: number): DeckSchedule[] {
  return schedules.filter((s) => s.enabled && !!s.workspaceId && s.nextRunAt <= now);
}

/**
 * Advance a schedule after a fire attempt. `ok`/`error` consume the occurrence:
 * a repeating schedule catches up PAST `now` (a laptop asleep for three days
 * fires once, not 4,320 times); a one-shot flips to disabled. `busy` leaves the
 * schedule due so the next tick retries.
 */
export function advanceAfterRun(s: DeckSchedule, result: 'ok' | 'busy' | 'error', now: number): DeckSchedule {
  if (result === 'busy') return { ...s, lastResult: 'busy' };
  const next = { ...s, lastRunAt: now, lastResult: result };
  if (s.intervalMinutes && s.intervalMinutes > 0) {
    const step = s.intervalMinutes * 60_000;
    let t = s.nextRunAt;
    while (t <= now) t += step;
    next.nextRunAt = t;
  } else {
    next.enabled = false;
  }
  return next;
}
