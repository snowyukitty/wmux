import fs from 'node:fs';
import path from 'node:path';

export interface SweepReport {
  promoted: string[];
  deleted: string[];
  left: string[];
}

export interface SweepOptions {
  log?: (line: string) => void;
}

const TMP_FILE_RE = /^(.+)\.tmp\.(\d+)\.(\d+)$/;

/**
 * Check if a process ID is currently alive.
 * Uses `process.kill(pid, 0)` semantics:
 * - If pid matches current process, it is alive.
 * - If process.kill(pid, 0) succeeds, it is alive.
 * - EPERM indicates the process exists (lack permissions), so it is alive.
 * - ESRCH indicates process does not exist.
 */
function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * Validate that a temp file parses as JSON with the root type expected by the store.
 * For `.json` targets only:
 * - Stores expecting an array root: deck-schedules.json, deck-work.archive.json
 * - Stores expecting an object root: deck-work.json, deck-loop-state.json, deck-autonomy.json, etc.
 * - Generic .json: object or array
 */
function validateTempJSON(filePath: string, primaryName: string): boolean {
  if (!primaryName.endsWith('.json')) return false;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return false;
    if (primaryName === 'deck-schedules.json' || primaryName === 'deck-work.archive.json') {
      return Array.isArray(parsed);
    }
    if (Array.isArray(parsed)) return false;
    // Mirror the Deck work store's own contract (deckWorkStore.loadFile): a file
    // without an `active` record loads as empty. Treating `{}` as valid here
    // would let such a backup outrank a temp that holds real work.
    if (primaryName === 'deck-work.json') {
      const active = (parsed as Record<string, unknown>).active;
      return !!active && typeof active === 'object' && !Array.isArray(active);
    }
    return true;
  } catch {
    return false;
  }
}

/** True when `<primary>.bak` parses with the store's root type and its mtime
 *  is not older than `mtimeMs`. */
function validBackupNewerThan(primaryPath: string, primaryName: string, mtimeMs: number): boolean {
  const bakPath = `${primaryPath}.bak`;
  try {
    const stat = fs.statSync(bakPath);
    if (!stat.isFile() || stat.mtimeMs < mtimeMs) return false;
  } catch {
    return false;
  }
  return validateTempJSON(bakPath, primaryName);
}

interface TempEntry {
  file: string;
  fullPath: string;
  primaryName: string;
  primaryPath: string;
  pid: number;
  counter: number;
  mtimeMs: number;
}

/**
 * Sweep orphaned atomic write temp files (*.tmp.<pid>.<n>) in the target data dir (non-recursive).
 *
 * Rules:
 * - Skip when pid is alive (process.kill(pid, 0) semantics, including our own pid, EPERM counts as alive).
 * - If primary file is missing AND temp is the newest for that primary AND it parses as JSON with
 *   the expected root type (object or array; for .json targets only): promote it by rename to primary,
 *   unless a valid `<primary>.bak` is at least as new (then every temp is left untouched and the
 *   reader keeps falling back to the backup).
 * - Every other dead-owner temp is deleted only when primary exists or temp does not parse.
 * - An unparseable temp with missing primary is left untouched and logged.
 * - Log one line per action.
 * - Never throws.
 */
export function sweepOrphanAtomicTemps(
  dir: string,
  opts?: SweepOptions,
): SweepReport {
  const promoted: string[] = [];
  const deleted: string[] = [];
  const left: string[] = [];

  const log = opts?.log ?? ((line: string) => {
    // eslint-disable-next-line no-console
    console.log(`[atomicWrite:sweep] ${line}`);
  });

  try {
    if (!fs.existsSync(dir)) {
      return { promoted, deleted, left };
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch (err) {
      log(`readdir failed for ${dir}: ${String(err)}`);
      return { promoted, deleted, left };
    }

    const deadTempsByPrimary = new Map<string, TempEntry[]>();

    for (const file of entries) {
      const match = TMP_FILE_RE.exec(file);
      if (!match) continue;

      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;

        const primaryName = match[1];
        const pid = parseInt(match[2], 10);
        const counter = parseInt(match[3], 10);

        if (isPidAlive(pid)) {
          left.push(file);
          log(`skipped live-pid temp: ${file} (pid ${pid})`);
          continue;
        }

        const primaryPath = path.join(dir, primaryName);
        const tempEntry: TempEntry = {
          file,
          fullPath,
          primaryName,
          primaryPath,
          pid,
          counter,
          mtimeMs: stat.mtimeMs,
        };

        const list = deadTempsByPrimary.get(primaryName) ?? [];
        list.push(tempEntry);
        deadTempsByPrimary.set(primaryName, list);
      } catch {
        // Stat error or file disappeared concurrently
      }
    }

    for (const [primaryName, temps] of deadTempsByPrimary) {
      const primaryPath = path.join(dir, primaryName);
      let primaryExists = fs.existsSync(primaryPath);

      // Sort newest first: mtimeMs descending, counter descending
      temps.sort((a, b) => b.mtimeMs - a.mtimeMs || b.counter - a.counter);

      if (primaryExists) {
        // Primary exists: every dead-owner temp is deleted
        for (const t of temps) {
          try {
            fs.unlinkSync(t.fullPath);
            deleted.push(t.file);
            log(`deleted dead temp with existing primary: ${t.file}`);
          } catch (err) {
            left.push(t.file);
            log(`failed to delete dead temp ${t.file}: ${String(err)}`);
          }
        }
      } else {
        // Primary is missing
        const newest = temps[0];
        const isValid = validateTempJSON(newest.fullPath, primaryName);

        // The atomic reader already falls back to `<primary>.bak` when the
        // primary is missing. A dead temp is a write that never committed, so
        // when a valid backup is at least as new, promoting the temp would put
        // OLDER content in front of it (an orphan from an earlier crash
        // shadowing a newer backup). Prefer the newest valid candidate: here
        // that is the backup, so leave every temp alone.
        const bakNewer = isValid && validBackupNewerThan(primaryPath, primaryName, newest.mtimeMs);
        if (bakNewer) {
          for (const t of temps) {
            left.push(t.file);
            log(`left dead temp older than a valid backup of missing ${primaryName}: ${t.file}`);
          }
          continue;
        }

        if (isValid) {
          // Promote newest by rename
          try {
            fs.renameSync(newest.fullPath, primaryPath);
            promoted.push(newest.file);
            primaryExists = true;
            log(`promoted ${newest.file} to ${primaryName}`);
          } catch (err) {
            left.push(newest.file);
            log(`failed to promote ${newest.file}: ${String(err)}`);
          }

          // Remaining dead temps for this primary: primary now exists, so delete them
          for (const t of temps.slice(1)) {
            try {
              fs.unlinkSync(t.fullPath);
              deleted.push(t.file);
              log(`deleted older dead temp: ${t.file}`);
            } catch (err) {
              left.push(t.file);
              log(`failed to delete older dead temp ${t.file}: ${String(err)}`);
            }
          }
        } else {
          // Newest temp is unparseable: leave untouched with missing primary
          left.push(newest.file);
          log(`left unparseable temp with missing primary: ${newest.file}`);

          for (const t of temps.slice(1)) {
            const otherValid = validateTempJSON(t.fullPath, primaryName);
            if (!otherValid) {
              // Unparseable with missing primary -> leave untouched
              left.push(t.file);
              log(`left unparseable temp with missing primary: ${t.file}`);
            } else {
              // Valid temp with missing primary that is not the newest -> left untouched
              left.push(t.file);
              log(`left dead temp with missing primary: ${t.file}`);
            }
          }
        }
      }
    }
  } catch (err) {
    log(`unexpected sweep failure: ${String(err)}`);
  }

  return { promoted, deleted, left };
}
