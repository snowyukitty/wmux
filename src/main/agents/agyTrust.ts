// ─── agy project trust for fan-out task folders ──────────────────────────────
//
// agy (Antigravity CLI) stops on "Do you trust the contents of this project?"
// in any folder that is not listed in its own settings file, even with
// --dangerously-skip-permissions, and trust is NOT inherited from a trusted
// parent. A fan-out worker lands in a brand-new worktree, so without help it
// waits forever on a screen only a keypress answers.
//
// Verified 2026-09-30, agy 1.2.14 on Windows: accepting the screen appends the
// exact folder to `trustedWorkspaces` in ~/.gemini/antigravity-cli/settings.json,
// and a folder pre-listed there launches straight into `-i "<prompt>"`.
//
// OPT-IN (owner decision): this is a persistent write into another CLI's
// global settings, so it only happens when the operator turned on "Trust agy
// fan-out task folders automatically" (Settings, fan-out workers; stored
// main-side in fanoutWorkerPolicy). With it off nothing is written and agy
// waits on its own trust screen.
//
// When on, fan-out lists exactly the task folder it is about to launch agy in
// — the same entry the operator's own keypress would write — and, on every
// call, drops entries for task folders under the same root that no longer
// exist, so removed worktrees do not accumulate. Nothing else in the file is
// touched. Only main writes here, and only for a folder FanOutService is
// spawning right now (see allowAgyTrustFor), never for a path the renderer
// names on its own.
//
// The write: a lock file beside the settings file serialises wmux processes
// (two instances fanning out at once); the file is re-read just before the
// commit and the edit redone if it changed meanwhile (agy itself writes this
// file and knows nothing of the lock); a symlinked settings file is written
// through to its target, keeping the link and the file's mode
// (shared/settingsFile writeJsonAtomic).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWriteTarget, writeJsonAtomic } from '../../shared/settingsFile';
import { loadFanoutTrustAgyFolders } from '../worktask/fanoutWorkerPolicy';

export function agySettingsPath(home: string = os.homedir()): string {
  return path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
}

/** Comparison key for a folder. Case folds only where the default filesystem
 *  is case-insensitive (Windows, macOS); on Linux `/a/Task` and `/a/task` are
 *  different folders. */
export function agyPathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const key = path.resolve(p).replace(/[\\/]+$/, '');
  return platform === 'win32' || platform === 'darwin' ? key.toLowerCase() : key;
}

const norm = (p: string): string => agyPathKey(p);

export type AgyTrustResult =
  | { ok: true; added: boolean; pruned: number }
  | { ok: false; reason: string; disabled?: true };

/** A lock older than this was left by a process that died mid-write. */
const STALE_LOCK_MS = 10_000;
const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;
/** Times the edit is redone when the file changed under it. */
const COMMIT_ATTEMPTS = 3;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface AgyTrustWriteDeps {
  readFile?: (p: string) => string;
  sleep?: (ms: number) => void;
  lockAttempts?: number;
  now?: () => number;
}

/** Run `fn` holding `<target>.wmux.lock`; 'busy' when it stays held. */
function withLock<T>(target: string, deps: AgyTrustWriteDeps, fn: () => T): T | 'busy' {
  const lockPath = `${target}.wmux.lock`;
  const sleep = deps.sleep ?? sleepSync;
  const now = deps.now ?? Date.now;
  const attempts = deps.lockAttempts ?? LOCK_ATTEMPTS;
  let acquired = false;
  for (let i = 0; i < attempts && !acquired; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      acquired = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue; // released between the open and the stat
      }
      sleep(LOCK_WAIT_MS);
    }
  }
  if (!acquired) return 'busy';
  try {
    return fn();
  } finally {
    try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
  }
}

/** List `folder` in agy's trustedWorkspaces; prune missing folders under `pruneUnder`. */
export function trustAgyWorkspace(
  folder: string,
  opts: { settingsPath?: string; pruneUnder?: string } = {},
  deps: AgyTrustWriteDeps = {},
): AgyTrustResult {
  const file = opts.settingsPath ?? agySettingsPath();
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  // The real file behind a symlink: the lock, the re-read and the write all
  // happen there, so the link itself is never replaced.
  const target = resolveWriteTarget(file);
  try {
    readFile(target);
  } catch {
    return { ok: false, reason: `agy settings not found at ${file} (run agy once to create it)` };
  }

  const edit = (raw: string): { data: Record<string, unknown>; added: boolean; pruned: number } | { error: string } => {
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      data = parsed as Record<string, unknown>;
    } catch (err) {
      return { error: `agy settings are not valid JSON: ${(err as Error).message}` };
    }
    const list = Array.isArray(data.trustedWorkspaces)
      ? data.trustedWorkspaces.filter((x): x is string => typeof x === 'string')
      : [];
    const root = opts.pruneUnder ? norm(opts.pruneUnder) + path.sep : undefined;
    const kept = list.filter((entry) => !(root && norm(entry).startsWith(root) && !fs.existsSync(entry)));
    const pruned = list.length - kept.length;
    const wanted = path.resolve(folder);
    const added = !kept.some((entry) => norm(entry) === norm(wanted));
    if (added) kept.push(wanted);
    data.trustedWorkspaces = kept;
    return { data, added, pruned };
  };

  let result: AgyTrustResult | 'busy';
  try {
    result = withLock(target, deps, (): AgyTrustResult => {
      for (let attempt = 1; attempt <= COMMIT_ATTEMPTS; attempt++) {
        const raw = readFile(target);
        const out = edit(raw);
        if ('error' in out) return { ok: false, reason: out.error };
        if (!out.added && out.pruned === 0) return { ok: true, added: false, pruned: 0 };
        // agy may have written since the read above: redo the edit on top of
        // its version rather than overwrite it.
        if (readFile(target) !== raw) continue;
        writeJsonAtomic(target, out.data);
        return { ok: true, added: out.added, pruned: out.pruned };
      }
      return { ok: false, reason: 'agy settings kept changing while wmux was writing; nothing written' };
    });
  } catch (err) {
    return { ok: false, reason: `could not write agy settings: ${(err as Error).message}` };
  }
  if (result === 'busy') return { ok: false, reason: 'agy settings are locked by another wmux write; nothing written' };
  return result;
}

// Folders FanOutService is spawning a worker in right now. The renderer decides
// the final launcher (a role binding may turn the default agent into agy), so it
// asks main to trust the folder — and main only agrees for these. Each spawn
// holds its own registration, so overlapping spawns in one folder release only
// their own; the folder main registered is what gets written, never the
// renderer's spelling of it.
interface SpawnRegistration {
  folder: string;
  pruneUnder?: string;
}
const spawning = new Map<string, Set<SpawnRegistration>>();

export function allowAgyTrustFor(folder: string, pruneUnder?: string): () => void {
  const key = norm(folder);
  const registration: SpawnRegistration = { folder, ...(pruneUnder ? { pruneUnder } : {}) };
  let set = spawning.get(key);
  if (!set) {
    set = new Set();
    spawning.set(key, set);
  }
  set.add(registration);
  return () => {
    const current = spawning.get(key);
    if (!current) return;
    current.delete(registration);
    if (current.size === 0) spawning.delete(key);
  };
}

export const AGY_TRUST_DISABLED_REASON =
  'automatic agy folder trust is off; agy will stop on its trust screen until it is answered';

export function trustAgyForSpawningFolder(
  folder: string,
  opts: { settingsPath?: string; enabled?: boolean } = {},
): AgyTrustResult {
  const registration = spawning.get(norm(folder))?.values().next().value;
  if (!registration) return { ok: false, reason: 'not a folder fan-out is launching a worker in' };
  // Read per call: the operator may flip the setting between two fan-outs.
  const enabled = opts.enabled ?? loadFanoutTrustAgyFolders();
  if (!enabled) return { ok: false, reason: AGY_TRUST_DISABLED_REASON, disabled: true };
  const { pruneUnder } = registration;
  return trustAgyWorkspace(registration.folder, {
    ...(opts.settingsPath ? { settingsPath: opts.settingsPath } : {}),
    ...(pruneUnder ? { pruneUnder } : {}),
  });
}
