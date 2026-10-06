import * as fs from 'fs';
import * as path from 'path';
import { copyFileAtomic } from '../../../shared/settingsFile';

export interface BackupOptions {
  now?: Date | number;
  maxBackups?: number;
}

function parseBackupTimestamp(suffix: string): number | null {
  const clean = suffix.replace(/-\d+$/, '');
  if (/^\d+$/.test(clean)) return Number(clean);
  const iso = clean.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  const ms = Date.parse(iso);
  return isNaN(ms) ? null : ms;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function backupFile(
  filePath: string,
  nowOrOptions?: Date | number | BackupOptions,
  maxBackupsCount = 5,
): string {
  let now: Date | number | undefined;
  let maxBackups = maxBackupsCount;

  if (nowOrOptions instanceof Date || typeof nowOrOptions === 'number') {
    now = nowOrOptions;
  } else if (nowOrOptions && typeof nowOrOptions === 'object') {
    now = nowOrOptions.now;
    if (typeof nowOrOptions.maxBackups === 'number') {
      maxBackups = nowOrOptions.maxBackups;
    }
  }

  const d = now instanceof Date ? now : typeof now === 'number' ? new Date(now) : new Date();
  const timestamp = d.toISOString().replace(/:/g, '-');

  let backupPath = `${filePath}.bak-wmux-${timestamp}`;
  if (fs.existsSync(backupPath)) {
    let counter = 1;
    while (fs.existsSync(`${backupPath}-${counter}`)) {
      counter++;
    }
    backupPath = `${backupPath}-${counter}`;
  }

  copyFileAtomic(filePath, backupPath);

  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const prefix = `${baseName}.bak-wmux-`;
  const escapedBase = escapeRegExp(baseName);
  const backupRegex = new RegExp(
    `^${escapedBase}\\.bak-wmux-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z(?:-\\d+)?$`,
  );

  try {
    const entries = fs.readdirSync(dir);
    const matching = entries.filter((e) => backupRegex.test(e));

    matching.sort((a, b) => {
      const tsA = parseBackupTimestamp(a.slice(prefix.length));
      const tsB = parseBackupTimestamp(b.slice(prefix.length));
      if (tsA !== null && tsB !== null && tsA !== tsB) {
        return tsA - tsB;
      }
      try {
        const mA = fs.statSync(path.join(dir, a)).mtimeMs;
        const mB = fs.statSync(path.join(dir, b)).mtimeMs;
        if (mA !== mB) return mA - mB;
      } catch {
        /* fall back to filename order */
      }
      return a.localeCompare(b);
    });

    if (matching.length > maxBackups) {
      const toDelete = matching.slice(0, matching.length - maxBackups);
      for (const file of toDelete) {
        try {
          fs.unlinkSync(path.join(dir, file));
        } catch {
          /* ignore deletion errors during prune */
        }
      }
    }
  } catch {
    /* dir read failure should not fail the backup itself */
  }

  return backupPath;
}
