import * as fs from 'fs';
import { writeFileAtomic } from './atomicWrite';
import { snapshotFile, type FileSnapshot } from './snapshot';

/** One file an apply call has already written, with what is needed to put it back. */
export interface WrittenFile {
  path: string;
  backupPath?: string;
  preExisted: boolean;
  /** Snapshot right after our write; a file that no longer matches it was changed by someone else. */
  postSnapshot: FileSnapshot;
}

/**
 * Restores files written earlier in a failed apply, newest first. A file changed since our write is
 * left alone. Returns false when any file could not be restored.
 */
export function rollbackWrittenFiles(written: readonly WrittenFile[]): boolean {
  let allRestored = true;
  for (const file of written.slice().reverse()) {
    try {
      const current = snapshotFile(file.path);
      if (!current.exists || current.sha256 !== file.postSnapshot.sha256) {
        allRestored = false;
        continue;
      }
      if (file.preExisted) {
        if (!file.backupPath || !fs.existsSync(file.backupPath)) {
          allRestored = false;
          continue;
        }
        writeFileAtomic(file.path, fs.readFileSync(file.backupPath, 'utf8'));
      } else {
        fs.unlinkSync(file.path);
      }
    } catch {
      allRestored = false;
    }
  }
  return allRestored;
}
