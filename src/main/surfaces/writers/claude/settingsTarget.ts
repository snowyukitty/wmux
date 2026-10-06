import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SurfaceFileEdit, SurfaceItem } from '../../../../shared/tokenUsage/surfaceTypes';
import { SurfacesStore } from '../../safeWrite';
import type { JsonEdit } from '../../safeWrite';
import type { ResolvedChange, WriterDeps } from '../types';
import { applyHookChangesToRoot } from './hookTarget';
import { foldPathCase } from '../../safeWrite/pathCase';
import { isPathAllowed, resolveCanonicalPath } from './pathSecurity';

function pathsEqual(p1: string, p2: string): boolean {
  const norm1 = path.normalize(p1);
  const norm2 = path.normalize(p2);
  return foldPathCase(norm1) === foldPathCase(norm2);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

export function isValidSettingsPath(targetPath: string | undefined | null, deps: WriterDeps): boolean {
  if (!targetPath) return false;
  const base = path.basename(targetPath);
  if (base !== 'settings.json' && base !== 'settings.local.json') {
    return false;
  }
  try {
    const canonicalTarget = resolveCanonicalPath(targetPath);
    const canonicalTargetDir = path.dirname(canonicalTarget);

    const canonicalHomeClaude = resolveCanonicalPath(path.join(deps.homeDir, '.claude'));
    if (pathsEqual(canonicalTargetDir, canonicalHomeClaude)) {
      return true;
    }

    if (deps.projectDir) {
      const canonicalProjClaude = resolveCanonicalPath(path.join(deps.projectDir, '.claude'));
      if (pathsEqual(canonicalTargetDir, canonicalProjClaude)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function resolveSettingsPath(item: SurfaceItem, deps: WriterDeps): string {
  // The file that already holds this item's deny or override wins.
  if (item.settingsPath && isValidSettingsPath(item.settingsPath, deps)) {
    return path.resolve(item.settingsPath);
  }
  if (item.originPath) {
    if (!isPathAllowed(item.originPath, deps)) {
      return path.resolve(item.originPath);
    }
    if (isValidSettingsPath(item.originPath, deps)) {
      return path.resolve(item.originPath);
    }
  }
  // A project item is switched for this project only, never in the user-wide file.
  if (item.source === 'project' && deps.projectDir) {
    return path.join(deps.projectDir, '.claude', 'settings.local.json');
  }
  return path.join(deps.homeDir, '.claude', 'settings.json');
}

export function buildSettingsEdits(
  targetPath: string,
  deps: WriterDeps,
  changes: ResolvedChange[],
  isApply: boolean,
  store?: SurfacesStore,
  /** The apply snapshot's text, so the plan and the conflict check see the same content. */
  snapshotText?: string | null,
): { edits: JsonEdit[]; fileEdits: SurfaceFileEdit[]; affectedItemIds: string[] } {
  if (!isPathAllowed(targetPath, deps)) {
    return { edits: [], fileEdits: [], affectedItemIds: [] };
  }

  let origRoot: Record<string, unknown> = {};
  const text =
    snapshotText !== undefined ? snapshotText : fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null;
  if (text !== null) {
    try {
      origRoot = JSON.parse(text);
    } catch {
      origRoot = {};
    }
  }

  const root: Record<string, unknown> = JSON.parse(JSON.stringify(origRoot));
  const fileEdits: SurfaceFileEdit[] = [];
  const affectedItemIds: string[] = [];
  const hookChanges: ResolvedChange[] = [];

  for (const c of changes) {
    const { item, enabled } = c;
    const rootBefore = JSON.stringify(root);
    const editsBefore = fileEdits.length;
    const affectedBefore = affectedItemIds.length;

    switch (item.kind) {
      case 'mcp-server': {
        // Disabling: non-project servers go to settings.json deniedMcpServers
        if (!enabled) {
          if (item.source !== 'project') {
            const denied = Array.isArray(root.deniedMcpServers)
              ? [...(root.deniedMcpServers as Record<string, unknown>[])]
              : [];
            const exists = denied.some(
              (d) => d && typeof d === 'object' && d.serverName === item.name,
            );
            if (!exists) {
              denied.push({ serverName: item.name });
            }
            root.deniedMcpServers = denied;
            fileEdits.push({
              path: targetPath,
              summary: `add "${item.name}" to deniedMcpServers`,
            });
            affectedItemIds.push(item.id);
          }
        } else {
          // Enabling: remove from deniedMcpServers if present
          if (Array.isArray(root.deniedMcpServers)) {
            const exists = (root.deniedMcpServers as Record<string, unknown>[]).some(
              (d) => d && typeof d === 'object' && d.serverName === item.name,
            );
            if (exists) {
              const filtered = (root.deniedMcpServers as Record<string, unknown>[]).filter(
                (d) => !(d && typeof d === 'object' && d.serverName === item.name),
              );
              if (filtered.length === 0) {
                delete root.deniedMcpServers;
              } else {
                root.deniedMcpServers = filtered;
              }
              fileEdits.push({
                path: targetPath,
                summary: `remove "${item.name}" from deniedMcpServers`,
              });
              if (!affectedItemIds.includes(item.id)) {
                affectedItemIds.push(item.id);
              }
            } else if (item.source !== 'project') {
              if (!affectedItemIds.includes(item.id)) {
                affectedItemIds.push(item.id);
              }
            }
          } else if (item.source !== 'project') {
            if (!affectedItemIds.includes(item.id)) {
              affectedItemIds.push(item.id);
            }
          }
        }
        break;
      }

      case 'mcp-tool': {
        const toolPattern = `mcp__${item.parent}__${item.name}`;
        if (!enabled) {
          if (!root.permissions || typeof root.permissions !== 'object') {
            root.permissions = {};
          }
          const perms = root.permissions as Record<string, unknown>;
          const deny = Array.isArray(perms.deny) ? [...(perms.deny as string[])] : [];
          if (!deny.includes(toolPattern)) {
            deny.push(toolPattern);
          }
          perms.deny = deny;
          fileEdits.push({
            path: targetPath,
            summary: `add "${toolPattern}" to permissions.deny`,
          });
          affectedItemIds.push(item.id);
        } else {
          if (root.permissions && typeof root.permissions === 'object') {
            const perms = root.permissions as Record<string, unknown>;
            if (Array.isArray(perms.deny)) {
              perms.deny = (perms.deny as string[]).filter((t) => t !== toolPattern);
              if ((perms.deny as string[]).length === 0) {
                delete perms.deny;
              }
              if (Object.keys(perms).length === 0) {
                delete root.permissions;
              }
            }
          }
          fileEdits.push({
            path: targetPath,
            summary: `remove "${toolPattern}" from permissions.deny`,
          });
          affectedItemIds.push(item.id);
        }
        break;
      }

      case 'builtin-tool': {
        const toolName = item.name;
        if (!enabled) {
          if (!root.permissions || typeof root.permissions !== 'object') {
            root.permissions = {};
          }
          const perms = root.permissions as Record<string, unknown>;
          const deny = Array.isArray(perms.deny) ? [...(perms.deny as string[])] : [];
          if (!deny.includes(toolName)) {
            deny.push(toolName);
          }
          perms.deny = deny;
          fileEdits.push({
            path: targetPath,
            summary: `add "${toolName}" to permissions.deny`,
          });
          affectedItemIds.push(item.id);
        } else {
          if (root.permissions && typeof root.permissions === 'object') {
            const perms = root.permissions as Record<string, unknown>;
            if (Array.isArray(perms.deny)) {
              perms.deny = (perms.deny as string[]).filter((t) => t !== toolName);
              if ((perms.deny as string[]).length === 0) {
                delete perms.deny;
              }
              if (Object.keys(perms).length === 0) {
                delete root.permissions;
              }
            }
          }
          fileEdits.push({
            path: targetPath,
            summary: `remove "${toolName}" from permissions.deny`,
          });
          affectedItemIds.push(item.id);
        }
        break;
      }

      case 'plugin': {
        if (!root.enabledPlugins || typeof root.enabledPlugins !== 'object') {
          root.enabledPlugins = {};
        }
        (root.enabledPlugins as Record<string, unknown>)[item.name] = enabled;
        fileEdits.push({
          path: targetPath,
          summary: `set enabledPlugins["${item.name}"] = ${enabled}`,
        });
        affectedItemIds.push(item.id);
        break;
      }

      case 'skill': {
        if (item.source === 'plugin') {
          // Plugin skills are not toggleable
          break;
        }
        if (!enabled) {
          if (!root.skillOverrides || typeof root.skillOverrides !== 'object') {
            root.skillOverrides = {};
          }
          (root.skillOverrides as Record<string, unknown>)[item.name] = 'off';
          fileEdits.push({
            path: targetPath,
            summary: `set skillOverrides["${item.name}"] = "off"`,
          });
          affectedItemIds.push(item.id);
        } else {
          if (root.skillOverrides && typeof root.skillOverrides === 'object') {
            delete (root.skillOverrides as Record<string, unknown>)[item.name];
            if (Object.keys(root.skillOverrides).length === 0) {
              delete root.skillOverrides;
            }
          }
          fileEdits.push({
            path: targetPath,
            summary: `delete skillOverrides["${item.name}"]`,
          });
          affectedItemIds.push(item.id);
        }
        break;
      }

      case 'context-setting': {
        // Numbers and lists are listed read-only; writing 1/0 over them would lose the user's value.
        if (typeof root[item.name] !== 'boolean') break;
        const value = item.name.startsWith('disable') ? !enabled : enabled;
        root[item.name] = value;
        fileEdits.push({
          path: targetPath,
          summary: `set ${item.name} = ${value}`,
        });
        affectedItemIds.push(item.id);
        break;
      }

      case 'hook': {
        if (item.source === 'managed') {
          // Managed hooks cannot be toggled
          break;
        }
        hookChanges.push(c);
        fileEdits.push({
          path: targetPath,
          summary: enabled
            ? `restore hook "${item.name}" to ${item.hookEvent ?? 'hooks'}`
            : `remove hook "${item.name}" from ${item.hookEvent ?? 'hooks'}`,
        });
        affectedItemIds.push(item.id);
        break;
      }
    }

    // An item whose case changed nothing in this file is not applied (its deny or override lives
    // elsewhere, or was never set): report it as unapplied instead of claiming success.
    if (item.kind !== 'hook' && JSON.stringify(root) === rootBefore) {
      fileEdits.splice(editsBefore);
      affectedItemIds.splice(affectedBefore);
    }
  }

  if (hookChanges.length > 0 && isApply && store) {
    applyHookChangesToRoot(root, hookChanges, targetPath, store);
  }

  // Generate top-level JsonEdits by comparing origRoot and root
  const edits: JsonEdit[] = [];
  const allKeys = new Set([...Object.keys(origRoot), ...Object.keys(root)]);

  for (const k of allKeys) {
    const origVal = origRoot[k];
    const newVal = root[k];
    if (!deepEqual(origVal, newVal)) {
      if (!(k in root)) {
        edits.push({ path: [k], op: 'delete' });
      } else {
        edits.push({ path: [k], op: 'set', value: newVal });
      }
    }
  }

  return { edits, fileEdits, affectedItemIds };
}
