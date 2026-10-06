import type {
  SurfaceApplyResult,
  SurfaceFileEdit,
  SurfacePreview,
} from '../../../shared/tokenUsage/surfaceTypes';
import {
  applyConfigEdit,
  ConfigChangedError,
  rollbackWrittenFiles,
  SurfacesStore,
  snapshotFile,
  type WrittenFile as RestorableFile,
} from '../safeWrite';
import type { ResolvedChange, SurfaceWriter, WriterContext } from './types';
import { buildClaudeJsonEdits, getClaudeJsonPath } from './claude/claudeJsonTarget';
import { buildSettingsEdits, resolveSettingsPath } from './claude/settingsTarget';
import { isPathAllowed } from './claude/pathSecurity';

export function createClaudeWriter(): SurfaceWriter {
  return {
    provider: 'claude',

    async preview(ctx: WriterContext): Promise<Omit<SurfacePreview, 'rejected'>> {
      const { deps, changes } = ctx;
      const edits: SurfaceFileEdit[] = [];

      // 1. ~/.claude.json edits
      const claudeJsonPath = getClaudeJsonPath(deps);
      if (isPathAllowed(claudeJsonPath, deps)) {
        const cjResult = buildClaudeJsonEdits(deps, changes);
        edits.push(...cjResult.fileEdits);
      }

      // 2. Settings files edits grouped by target path
      const settingsChangesByPath = new Map<string, ResolvedChange[]>();
      for (const c of changes) {
        // Skip project MCP server disables as they only target ~/.claude.json
        if (c.item.kind === 'mcp-server' && c.item.source === 'project' && !c.enabled) {
          continue;
        }
        const targetPath = resolveSettingsPath(c.item, deps);
        const list = settingsChangesByPath.get(targetPath) ?? [];
        list.push(c);
        settingsChangesByPath.set(targetPath, list);
      }

      for (const [targetPath, pathChanges] of settingsChangesByPath.entries()) {
        if (!isPathAllowed(targetPath, deps)) {
          continue;
        }
        const sResult = buildSettingsEdits(targetPath, deps, pathChanges, false);
        edits.push(...sResult.fileEdits);
      }

      return {
        provider: 'claude',
        edits,
        requiresNewSession: true,
      };
    },

    async apply(ctx: WriterContext): Promise<SurfaceApplyResult> {
      const { deps, changes } = ctx;
      const appliedItemIds: string[] = [];
      const backups: string[] = [];
      const store = new SurfacesStore(deps.surfacesStorePath);
      store.load();

      interface WrittenFile extends RestorableFile {
        affectedItemIds: string[];
      }
      const writtenFiles: WrittenFile[] = [];
      const hookIdsToTakeFromStore: string[] = [];

      try {
        // 1. Apply to ~/.claude.json if needed
        const claudeJsonPath = getClaudeJsonPath(deps);
        let cjResult: { edits: any[]; fileEdits: any[]; affectedItemIds: string[] } = {
          edits: [],
          fileEdits: [],
          affectedItemIds: [],
        };
        if (isPathAllowed(claudeJsonPath, deps)) {
          const cjSnapshot = snapshotFile(claudeJsonPath);
          cjResult = buildClaudeJsonEdits(deps, changes, cjSnapshot.text);
          if (cjResult.edits.length > 0) {
            const preExisted = cjSnapshot.exists;
            const res = applyConfigEdit({
              path: claudeJsonPath,
              kind: 'json',
              edits: cjResult.edits,
              backup: true,
              snapshot: cjSnapshot,
              now: deps.now(),
            });
            if (res.backupPath) backups.push(res.backupPath);
            if (res.changed) {
              writtenFiles.push({
                path: claudeJsonPath,
                backupPath: res.backupPath,
                preExisted,
                postSnapshot: snapshotFile(claudeJsonPath),
                affectedItemIds: [...cjResult.affectedItemIds],
              });
            }
          }
        }

        // 2. Apply to settings files
        const settingsChangesByPath = new Map<string, ResolvedChange[]>();
        for (const c of changes) {
          if (c.item.kind === 'mcp-server' && c.item.source === 'project' && !c.enabled) {
            continue;
          }
          const targetPath = resolveSettingsPath(c.item, deps);
          const list = settingsChangesByPath.get(targetPath) ?? [];
          list.push(c);
          settingsChangesByPath.set(targetPath, list);
        }

        const settingsResults: { affectedItemIds: string[] }[] = [];

        for (const [targetPath, pathChanges] of settingsChangesByPath.entries()) {
          if (!isPathAllowed(targetPath, deps)) {
            continue;
          }
          const snapshot = snapshotFile(targetPath);
          const sResult = buildSettingsEdits(targetPath, deps, pathChanges, true, store, snapshot.text);
          settingsResults.push(sResult);
          if (sResult.edits.length > 0) {
            const preExisted = snapshot.exists;
            const res = applyConfigEdit({
              path: targetPath,
              kind: 'json',
              edits: sResult.edits,
              backup: true,
              snapshot,
              now: deps.now(),
            });
            if (res.backupPath) backups.push(res.backupPath);
            if (res.changed) {
              writtenFiles.push({
                path: targetPath,
                backupPath: res.backupPath,
                preExisted,
                postSnapshot: snapshotFile(targetPath),
                affectedItemIds: [...sResult.affectedItemIds],
              });
            }
          }
          for (const c of pathChanges) {
            if (c.item.kind === 'hook' && c.enabled && sResult.affectedItemIds.includes(c.item.id)) {
              if (!hookIdsToTakeFromStore.includes(c.item.id)) {
                hookIdsToTakeFromStore.push(c.item.id);
              }
            }
          }
        }

        // All file writes succeeded!
        // Remove enabled hooks from store and save
        for (const id of hookIdsToTakeFromStore) {
          store.removedHooks.take('claude', id);
        }
        try {
          store.save();
        } catch {
          // If the store save fails after a successful write, still report the hook as applied
        }

        // Populate appliedItemIds
        for (const id of cjResult.affectedItemIds) {
          if (!appliedItemIds.includes(id)) appliedItemIds.push(id);
        }
        for (const sRes of settingsResults) {
          for (const id of sRes.affectedItemIds) {
            if (!appliedItemIds.includes(id)) appliedItemIds.push(id);
          }
        }

        // Record intent in surfacesStore for all landed items
        try {
          for (const itemId of appliedItemIds) {
            const c = changes.find((x) => x.item.id === itemId);
            if (c) {
              store.recordIntent('claude', itemId, c.enabled);
            }
          }
          store.save();
        } catch {
          // Store failure must not fail apply
        }

        const unapplied = changes.some((c) => !appliedItemIds.includes(c.item.id));
        return {
          provider: 'claude',
          ok: !unapplied,
          appliedItemIds,
          backups,
          error: unapplied ? 'Some changes could not be applied.' : null,
        };
      } catch (err: unknown) {
        if (err instanceof Error) {
          if (err.message.includes('Project directory is required')) {
            throw new Error('Project directory is required to toggle project MCP server');
          }
        }

        // Roll back any files that were written in this apply call
        const rollbackFailed = !rollbackWrittenFiles(writtenFiles);

        const isMissingStoreDef =
          err instanceof Error && err.message.includes('definition not found in store');
        const isAmbiguousHook = err instanceof Error && err.message.startsWith('More than one hook matches');
        const safeError = rollbackFailed
          ? 'Some files may have changed; check your Claude settings.'
          : isMissingStoreDef
            ? 'Cannot enable hook: definition not found in store'
            : isAmbiguousHook
              ? (err as Error).message
            : err instanceof ConfigChangedError
              ? 'The configuration changed while editing; reload and try again.'
              : 'Applying the change failed; no file was left half-written.';

        return {
          provider: 'claude',
          ok: false,
          appliedItemIds: [],
          backups,
          error: safeError,
        };
      }
    },
  };
}
