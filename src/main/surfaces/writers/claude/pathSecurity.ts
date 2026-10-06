import * as fs from 'node:fs';
import * as path from 'node:path';
import { foldPathCase } from '../../safeWrite/pathCase';
import type { WriterDeps } from '../types';

export function resolveCanonicalPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) {
    return fs.realpathSync(resolved);
  }
  const parent = path.dirname(resolved);
  if (parent === resolved) {
    return resolved;
  }
  const realParent = resolveCanonicalPath(parent);
  return path.join(realParent, path.basename(resolved));
}

export function isSubpathOrEqual(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const normChild = foldPathCase(path.normalize(child), platform);
  const normParent = foldPathCase(path.normalize(parent), platform);
  if (normChild === normParent) return true;
  const parentWithSep = normParent.endsWith(path.sep) ? normParent : normParent + path.sep;
  return normChild.startsWith(parentWithSep);
}

export function isPathAllowed(targetPath: string, deps: WriterDeps): boolean {
  try {
    const canonicalTarget = resolveCanonicalPath(targetPath);
    const canonicalHome = resolveCanonicalPath(deps.homeDir);
    if (isSubpathOrEqual(canonicalTarget, canonicalHome)) {
      return true;
    }
    if (deps.projectDir) {
      const canonicalProj = resolveCanonicalPath(deps.projectDir);
      if (isSubpathOrEqual(canonicalTarget, canonicalProj)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
