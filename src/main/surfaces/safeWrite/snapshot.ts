import * as fs from 'fs';
import { createHash } from 'crypto';

export class ConfigChangedError extends Error {
  readonly path: string;
  readonly reason: 'appeared' | 'vanished' | 'modified';

  constructor(path: string, reason: 'appeared' | 'vanished' | 'modified', message?: string) {
    super(message ?? `Config file changed (${reason}): ${path}`);
    this.name = 'ConfigChangedError';
    this.path = path;
    this.reason = reason;
  }
}

export interface FileSnapshot {
  exists: boolean;
  mtimeMs: number | null;
  sha256: string | null;
  text: string | null;
}

export function snapshotFile(filePath: string): FileSnapshot {
  try {
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, 'utf8');
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    return {
      exists: true,
      mtimeMs: stat.mtimeMs,
      sha256,
      text,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        exists: false,
        mtimeMs: null,
        sha256: null,
        text: null,
      };
    }
    throw err;
  }
}

export function assertUnchanged(filePath: string, snapshot: FileSnapshot): void {
  const current = snapshotFile(filePath);
  if (!snapshot.exists && current.exists) {
    throw new ConfigChangedError(filePath, 'appeared');
  }
  if (snapshot.exists && !current.exists) {
    throw new ConfigChangedError(filePath, 'vanished');
  }
  if (snapshot.exists && current.exists && snapshot.sha256 !== current.sha256) {
    throw new ConfigChangedError(filePath, 'modified');
  }
}
