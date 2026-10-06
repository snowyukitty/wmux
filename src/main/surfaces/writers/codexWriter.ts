import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  applyConfigEdit,
  ConfigChangedError,
  snapshotFile,
  SurfacesStore,
} from '../safeWrite';
import type { SurfaceApplyResult } from '../../../shared/tokenUsage/surfaceTypes';
import type { ResolvedChange, SurfaceWriter, WriterContext } from './types';
import { isPathSafe } from './codex/pathSafety';
import { planEdits } from './codex/planEdits';

export function createCodexWriter(): SurfaceWriter {
  return {
    provider: 'codex',

    async preview(ctx: WriterContext) {
      const configPath = path.join(ctx.deps.homeDir, '.codex', 'config.toml');
      if (!isPathSafe(configPath, ctx.deps.homeDir, ctx.deps.projectDir)) {
        return { provider: 'codex', edits: [], requiresNewSession: true };
      }

      const safeChanges: ResolvedChange[] = [];
      for (const change of ctx.changes) {
        if (
          change.item.originPath &&
          !isPathSafe(change.item.originPath, ctx.deps.homeDir, ctx.deps.projectDir)
        ) {
          continue;
        }
        safeChanges.push(change);
      }

      if (safeChanges.length === 0) {
        return { provider: 'codex', edits: [], requiresNewSession: true };
      }

      const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
      const plan = planEdits(text, configPath, safeChanges, ctx.deps);

      return {
        provider: 'codex',
        edits: plan.edits,
        requiresNewSession: true,
      };
    },

    async apply(ctx: WriterContext) {
      const result = await applyCodex(ctx);
      // A change refused for its path must not hide behind an ok result (same rule as the agy writer).
      const refused = ctx.changes.filter((c) => c.item.originPath
        && !isPathSafe(c.item.originPath, ctx.deps.homeDir, ctx.deps.projectDir));
      if (refused.length > 0 && result.ok) {
        return { ...result, ok: false, error: 'Refused to modify configuration outside allowed directories.' };
      }
      return result;
    },
  };
}

async function applyCodex(ctx: WriterContext): Promise<SurfaceApplyResult> {
  const configPath = path.join(ctx.deps.homeDir, '.codex', 'config.toml');
  if (!isPathSafe(configPath, ctx.deps.homeDir, ctx.deps.projectDir)) {
    return {
      provider: 'codex',
      ok: false,
      appliedItemIds: [],
      backups: [],
      error: 'Refused to modify configuration outside allowed directories.',
    };
  }

  const safeChanges: ResolvedChange[] = [];
  for (const change of ctx.changes) {
    if (
      change.item.originPath &&
      !isPathSafe(change.item.originPath, ctx.deps.homeDir, ctx.deps.projectDir)
    ) {
      continue;
    }
    safeChanges.push(change);
  }

  if (safeChanges.length === 0) {
    return {
      provider: 'codex',
      ok: false,
      appliedItemIds: [],
      backups: [],
      error: 'Refused to modify configuration outside allowed directories.',
    };
  }

  const snap = snapshotFile(configPath);
  const text = snap.exists ? snap.text! : '';
  const plan = planEdits(text, configPath, safeChanges, ctx.deps);

  if (plan.tomlEdits.length === 0) {
    return {
      provider: 'codex',
      ok: true,
      appliedItemIds: plan.applicableItemIds,
      backups: [],
      error: null,
    };
  }

  const backups: string[] = [];
  const appliedItemIds: string[] = [];

  try {
    const result = applyConfigEdit({
      path: configPath,
      kind: 'toml',
      edits: plan.tomlEdits,
      backup: true,
      now: ctx.deps.now(),
      snapshot: snap,
    });

    if (result.backupPath) {
      backups.push(result.backupPath);
    }
    appliedItemIds.push(...plan.applicableItemIds);
  } catch (err) {
    const isConfigChanged = err instanceof ConfigChangedError;
    const errorMessage = isConfigChanged
      ? 'The configuration changed while editing; reload and try again.'
      : 'Applying configuration changes failed.';

    return {
      provider: 'codex',
      ok: false,
      appliedItemIds,
      backups,
      error: errorMessage,
    };
  }

  try {
    const store = new SurfacesStore(ctx.deps.surfacesStorePath);
    store.load();
    for (const change of safeChanges) {
      if (appliedItemIds.includes(change.item.id)) {
        store.recordIntent('codex', change.item.id, change.enabled);
      }
    }
    store.save();
  } catch {
    // Failing store must not fail the apply
  }

  return {
    provider: 'codex',
    ok: true,
    appliedItemIds,
    backups,
    error: null,
  };
}
