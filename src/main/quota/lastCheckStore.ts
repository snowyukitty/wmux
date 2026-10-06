import * as fs from 'fs';
import * as path from 'path';

export interface LastCheckEntry {
  usedPct: number | null;
  resetAtMs: number | null;
  checkedAtMs: number;
  quotaCapturedAtMs?: number | null;
}

export type LastCheckStoreData = Record<string, LastCheckEntry>;

export interface LastCheckIo {
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (filePath: string) => Promise<void>;
  mkdir?: (dirPath: string) => Promise<void>;
}

export function lastCheckKey(provider: string, windowId: string): string {
  return `${provider}:${windowId}`;
}

export function isValidLastCheckEntry(val: unknown): val is LastCheckEntry {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    return false;
  }
  const entry = val as Record<string, unknown>;

  // checkedAtMs: required finite number >= 0
  if (
    typeof entry.checkedAtMs !== 'number' ||
    !Number.isFinite(entry.checkedAtMs) ||
    entry.checkedAtMs < 0
  ) {
    return false;
  }

  // usedPct: required number | null. If number, must be finite >= 0
  if (entry.usedPct === undefined) {
    return false;
  }
  if (entry.usedPct !== null) {
    if (
      typeof entry.usedPct !== 'number' ||
      !Number.isFinite(entry.usedPct) ||
      entry.usedPct < 0
    ) {
      return false;
    }
  }

  // resetAtMs: required number | null. If number, must be finite >= 0
  if (entry.resetAtMs === undefined) {
    return false;
  }
  if (entry.resetAtMs !== null) {
    if (
      typeof entry.resetAtMs !== 'number' ||
      !Number.isFinite(entry.resetAtMs) ||
      entry.resetAtMs < 0
    ) {
      return false;
    }
  }

  // quotaCapturedAtMs: optional (undefined, null, or finite number >= 0)
  if (entry.quotaCapturedAtMs !== undefined && entry.quotaCapturedAtMs !== null) {
    if (
      typeof entry.quotaCapturedAtMs !== 'number' ||
      !Number.isFinite(entry.quotaCapturedAtMs) ||
      entry.quotaCapturedAtMs < 0
    ) {
      return false;
    }
  }

  return true;
}

export async function loadLastCheckStore(
  quotaDir: string,
  io?: Pick<LastCheckIo, 'readFile'>,
): Promise<LastCheckStoreData> {
  const filePath = path.join(quotaDir, 'last-check.json');
  try {
    const raw = io?.readFile
      ? await io.readFile(filePath)
      : await fs.promises.readFile(filePath, 'utf8');
    if (!raw || raw.trim().length === 0) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: LastCheckStoreData = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (isValidLastCheckEntry(value)) {
          result[key] = {
            usedPct: value.usedPct,
            resetAtMs: value.resetAtMs,
            checkedAtMs: value.checkedAtMs,
            quotaCapturedAtMs: value.quotaCapturedAtMs ?? null,
          };
        }
      }
      return result;
    }
    return {};
  } catch {
    return {};
  }
}

export async function saveLastCheckStore(
  quotaDir: string,
  data: LastCheckStoreData,
  io?: LastCheckIo,
): Promise<void> {
  const targetPath = path.join(quotaDir, 'last-check.json');
  const rand = Math.random().toString(16).slice(2);
  const tmpPath = path.join(quotaDir, `last-check.${process.pid}.${Date.now()}.${rand}.tmp`);
  const content = JSON.stringify(data, null, 2) + '\n';

  const doMkdir = io?.mkdir ?? ((d: string) => fs.promises.mkdir(d, { recursive: true }));
  const doWrite = io?.writeFile ?? ((p: string, c: string) => fs.promises.writeFile(p, c, 'utf8'));
  const doRename = io?.rename ?? ((from: string, to: string) => fs.promises.rename(from, to));
  const doUnlink = io?.unlink ?? ((p: string) => fs.promises.unlink(p));

  await doMkdir(quotaDir);

  try {
    await doWrite(tmpPath, content);
    await doRename(tmpPath, targetPath);
  } catch (err) {
    try {
      await doUnlink(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}
