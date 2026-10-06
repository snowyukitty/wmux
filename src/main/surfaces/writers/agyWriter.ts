import type { SurfaceWriter, WriterContext } from './types';
import type { SurfaceApplyResult, SurfacePreview } from '../../../shared/tokenUsage/surfaceTypes';
import {
  applyConfigEdit,
  ConfigChangedError,
  rollbackWrittenFiles,
  snapshotFile,
  SurfacesStore,
  type WrittenFile,
} from '../safeWrite';
import { isPathAllowed, resolveTargetFile } from './agy/paths';
import { planEditsForFile } from './agy/edits';

export function createAgyWriter(): SurfaceWriter {
  return {
    provider: 'agy',

    async preview(ctx: WriterContext): Promise<Omit<SurfacePreview, 'rejected'>> {
      const changesByFile = new Map<string, typeof ctx.changes>();

      for (const change of ctx.changes) {
        const targetPath = resolveTargetFile(change.item, ctx.deps);
        if (!isPathAllowed(targetPath, ctx.deps)) {
          continue;
        }

        const existing = changesByFile.get(targetPath) ?? [];
        existing.push(change);
        changesByFile.set(targetPath, existing);
      }

      const edits = [];
      for (const [targetPath, changes] of changesByFile.entries()) {
        const planned = planEditsForFile(targetPath, changes);
        edits.push(...planned.previewEdits);
      }

      return {
        provider: 'agy',
        edits,
        requiresNewSession: true,
      };
    },

    async apply(ctx: WriterContext): Promise<SurfaceApplyResult> {
      const changesByFile = new Map<string, typeof ctx.changes>();
      let hasRefused = false;

      for (const change of ctx.changes) {
        const targetPath = resolveTargetFile(change.item, ctx.deps);
        if (!isPathAllowed(targetPath, ctx.deps)) {
          hasRefused = true;
          continue;
        }

        const existing = changesByFile.get(targetPath) ?? [];
        existing.push(change);
        changesByFile.set(targetPath, existing);
      }

      const appliedItemIds: string[] = [];
      const backups: string[] = [];
      let ok = true;
      let error: string | null = null;

      if (changesByFile.size === 0) {
        return {
          provider: 'agy',
          ok: false,
          appliedItemIds: [],
          backups: [],
          error: hasRefused
            ? 'Refused to modify configuration outside allowed directories.'
            : 'Nothing to change.',
        };
      }

      const written: WrittenFile[] = [];
      for (const [targetPath, changes] of changesByFile.entries()) {
        const snapshot = snapshotFile(targetPath);
        const planned = planEditsForFile(targetPath, changes, snapshot.text);

        try {
          const res = applyConfigEdit({
            path: targetPath,
            kind: 'json',
            edits: planned.jsonEdits,
            backup: true,
            snapshot,
            now: ctx.deps.now(),
          });

          if (res.backupPath) {
            backups.push(res.backupPath);
          }
          if (res.changed) {
            written.push({
              path: targetPath,
              backupPath: res.backupPath,
              preExisted: snapshot.exists,
              postSnapshot: snapshotFile(targetPath),
            });
          }
          appliedItemIds.push(...planned.itemIds);
        } catch (err) {
          ok = false;
          // Put back the files written before this one, so a failed apply changes nothing.
          const restored = rollbackWrittenFiles(written);
          appliedItemIds.length = 0;
          if (!restored) {
            error = 'Some files may have changed; check your agy settings.';
          } else if (err instanceof ConfigChangedError) {
            error = 'The configuration changed while editing; reload and try again.';
          } else {
            error = 'Applying the change failed; no file was left half-written.';
          }
          break;
        }
      }

      if (hasRefused && ok) {
        ok = false;
        error = 'Refused to modify configuration outside allowed directories.';
      }

      if (appliedItemIds.length > 0) {
        try {
          const store = new SurfacesStore(ctx.deps.surfacesStorePath);
          store.load();
          for (const itemId of appliedItemIds) {
            const change = ctx.changes.find((c) => c.item.id === itemId);
            if (change) {
              store.recordIntent('agy', itemId, change.enabled);
            }
          }
          store.save();
        } catch {
          // A failing store must not fail the apply (ignore its warnings).
        }
      }

      return {
        provider: 'agy',
        ok,
        appliedItemIds,
        backups,
        error,
      };
    },
  };
}
