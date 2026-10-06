import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { fsyncDir, renameWithRetry, resolveWriteTarget } from '../../../shared/settingsFile';

const NEW_FILE_MODE = 0o600;

function existingMode(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return null;
  }
}

export function writeFileAtomic(filePath: string, text: string): void {
  const target = resolveWriteTarget(filePath);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const mode = existingMode(target) ?? NEW_FILE_MODE;
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      /* chmod might fail or be no-op on some platforms */
    }
    renameWithRetry(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created, or already gone */
    }
    throw err;
  }
  fsyncDir(dir);
}
