import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SurfaceItem } from '../../../../shared/tokenUsage/surfaceTypes';
import { foldPathCase } from '../../safeWrite/pathCase';
import type { WriterDeps } from '../types';

function safeRealpath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    const resolved = path.resolve(targetPath);
    const parsed = path.parse(resolved);
    let cur = path.dirname(resolved);
    const segments: string[] = [path.basename(resolved)];
    while (cur !== parsed.root) {
      try {
        const realCur = fs.realpathSync(cur);
        return path.join(realCur, ...segments.reverse());
      } catch {
        segments.push(path.basename(cur));
        cur = path.dirname(cur);
      }
    }
    return resolved;
  }
}

export function isWithin(root: string, target: string): boolean {
  const normRoot = foldPathCase(root);
  const normTarget = foldPathCase(target);
  const rel = path.relative(normRoot, normTarget);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isPathAllowed(targetPath: string, deps: WriterDeps): boolean {
  const realTarget = safeRealpath(targetPath);
  const realHome = safeRealpath(deps.homeDir);
  if (isWithin(realHome, realTarget)) {
    return true;
  }
  if (deps.projectDir) {
    const realProject = safeRealpath(deps.projectDir);
    if (isWithin(realProject, realTarget)) {
      return true;
    }
  }
  return false;
}

export function getPluginDirName(item: SurfaceItem): string {
  if (item.originPath) {
    return path.basename(path.dirname(item.originPath));
  }
  return item.name;
}

export function getSkillDirName(item: SurfaceItem): string {
  if (item.originPath) {
    return path.basename(path.dirname(item.originPath));
  }
  return item.name;
}

export function resolveSkillConfigFile(item: SurfaceItem, deps: WriterDeps): string {
  if (item.originPath) {
    const realOrigin = safeRealpath(item.originPath);
    if (deps.projectDir) {
      const candidateProjectRoots = [
        path.join(deps.projectDir, '.agents', 'skills'),
        path.join(deps.projectDir, '.agents'),
      ];
      if (item.source === 'project') {
        candidateProjectRoots.push(deps.projectDir);
      }
      for (const cand of candidateProjectRoots) {
        if (isWithin(safeRealpath(cand), realOrigin)) {
          return path.join(deps.projectDir, '.agents', 'skills.json');
        }
      }
    }
    const candidateUserRoots = [
      path.join(deps.homeDir, '.gemini', 'config', 'skills'),
      path.join(deps.homeDir, '.gemini', 'config'),
      path.join(deps.homeDir, '.gemini', 'antigravity-cli', 'skills'),
      path.join(deps.homeDir, '.gemini', 'antigravity-cli'),
    ];
    for (const cand of candidateUserRoots) {
      if (isWithin(safeRealpath(cand), realOrigin)) {
        return path.join(deps.homeDir, '.gemini', 'config', 'skills.json');
      }
    }
  }
  if (item.source === 'project' && deps.projectDir) {
    return path.join(deps.projectDir, '.agents', 'skills.json');
  }
  return path.join(deps.homeDir, '.gemini', 'config', 'skills.json');
}

export function resolveTargetFile(item: SurfaceItem, deps: WriterDeps): string {
  switch (item.kind) {
    case 'mcp-server':
    case 'mcp-tool':
      return item.originPath ?? path.join(deps.homeDir, '.gemini', 'config', 'mcp_config.json');
    case 'plugin':
      return path.join(deps.homeDir, '.gemini', 'config', 'config.json');
    case 'skill':
      if (item.source === 'builtin' || item.source === 'plugin') {
        throw new Error(`Skill ${item.name} from source ${item.source} cannot be toggled`);
      }
      return resolveSkillConfigFile(item, deps);
    case 'hook':
      return item.originPath ?? path.join(deps.homeDir, '.gemini', 'config', 'hooks.json');
    default:
      throw new Error(`Unsupported item kind: ${item.kind}`);
  }
}
