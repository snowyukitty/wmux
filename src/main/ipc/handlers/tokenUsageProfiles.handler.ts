import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type {
  ProfileApplyAggregateResult,
  ProfilePreviewResult,
  SaveProfileRequest,
  SaveProfileResult,
  SurfaceProfile,
} from '../../../shared/tokenUsage/profileTypes';
import type { SurfaceProviderId } from '../../../shared/tokenUsage/surfaceTypes';
import {
  applyProfile,
  deleteProfile,
  listProfiles,
  previewProfile,
  saveProfile,
  type ProfileServiceOptions,
} from '../../surfaces/profiles';

const VALID_PROVIDERS: ReadonlySet<SurfaceProviderId> = new Set(['claude', 'codex', 'agy']);

function assertSaveRequest(request: unknown): { name: string; providers?: SurfaceProviderId[] } {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Invalid save profile request.');
  }
  const req = request as Record<string, unknown>;
  if (typeof req.name !== 'string') {
    throw new Error('Profile name must be a string.');
  }
  const name = req.name.trim();
  if (name.length < 1 || name.length > 40) {
    throw new Error('Profile name must be between 1 and 40 characters.');
  }

  let providers: SurfaceProviderId[] | undefined;
  if (req.providers !== undefined) {
    if (!Array.isArray(req.providers)) {
      throw new Error('Providers must be an array.');
    }
    for (const p of req.providers) {
      if (typeof p !== 'string' || !VALID_PROVIDERS.has(p as SurfaceProviderId)) {
        throw new Error('Unknown provider.');
      }
    }
    providers = req.providers as SurfaceProviderId[];
  }

  return { name, providers };
}

function assertIdRequest(request: unknown, action: string): string {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(`Invalid ${action} profile request.`);
  }
  const req = request as Record<string, unknown>;
  if (typeof req.id !== 'string' || !req.id.trim()) {
    throw new Error('Profile id must be a non-empty string.');
  }
  return req.id.trim();
}

function assertApplyRequest(request: unknown): { id: string } {
  const id = assertIdRequest(request, 'apply');
  return { id };
}

export function registerTokenUsageProfilesHandlers(options?: ProfileServiceOptions): () => void {
  ipcMain.removeHandler(IPC.TOKEN_PROFILES_LIST);
  ipcMain.handle(
    IPC.TOKEN_PROFILES_LIST,
    wrapHandler(IPC.TOKEN_PROFILES_LIST, async (): Promise<SurfaceProfile[]> => {
      try {
        return await listProfiles(options);
      } catch {
        throw new Error('Failed to list surface profiles.');
      }
    }),
  );

  ipcMain.removeHandler(IPC.TOKEN_PROFILES_SAVE);
  ipcMain.handle(
    IPC.TOKEN_PROFILES_SAVE,
    wrapHandler(IPC.TOKEN_PROFILES_SAVE, async (_event, request: unknown): Promise<SaveProfileResult> => {
      const { name, providers } = assertSaveRequest(request);
      try {
        return await saveProfile(name, providers, options);
      } catch (err) {
        const msg = (err as Error).message || '';
        if (msg.includes('already exists')) {
          throw new Error('A profile with this name already exists.');
        }
        if (msg.startsWith('Maximum number of profiles')) {
          throw new Error('Maximum number of profiles (50) reached.');
        }
        if (msg.includes('Storage version') || msg.includes('storage version')) {
          throw new Error('Storage version is not supported.');
        }
        throw new Error('Failed to save surface profile.');
      }
    }),
  );

  ipcMain.removeHandler(IPC.TOKEN_PROFILES_DELETE);
  ipcMain.handle(
    IPC.TOKEN_PROFILES_DELETE,
    wrapHandler(IPC.TOKEN_PROFILES_DELETE, async (_event, request: unknown): Promise<boolean> => {
      const id = assertIdRequest(request, 'delete');
      try {
        return await deleteProfile(id, options);
      } catch {
        throw new Error('Failed to delete surface profile.');
      }
    }),
  );

  ipcMain.removeHandler(IPC.TOKEN_PROFILES_PREVIEW);
  ipcMain.handle(
    IPC.TOKEN_PROFILES_PREVIEW,
    wrapHandler(IPC.TOKEN_PROFILES_PREVIEW, async (_event, request: unknown): Promise<ProfilePreviewResult> => {
      const id = assertIdRequest(request, 'preview');
      try {
        return await previewProfile(id, options);
      } catch (err) {
        const msg = (err as Error).message || '';
        if (msg.includes('not found') || msg.includes('Not found')) {
          throw new Error('Profile not found.');
        }
        throw new Error('Failed to preview surface profile.');
      }
    }),
  );

  ipcMain.removeHandler(IPC.TOKEN_PROFILES_APPLY);
  ipcMain.handle(
    IPC.TOKEN_PROFILES_APPLY,
    wrapHandler(IPC.TOKEN_PROFILES_APPLY, async (_event, request: unknown): Promise<ProfileApplyAggregateResult> => {
      const { id } = assertApplyRequest(request);
      try {
        return await applyProfile(id, options);
      } catch (err) {
        const msg = (err as Error).message || '';
        if (msg.includes('not found') || msg.includes('Not found')) {
          throw new Error('Profile not found.');
        }
        throw new Error('Failed to apply surface profile.');
      }
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.TOKEN_PROFILES_LIST);
    ipcMain.removeHandler(IPC.TOKEN_PROFILES_SAVE);
    ipcMain.removeHandler(IPC.TOKEN_PROFILES_DELETE);
    ipcMain.removeHandler(IPC.TOKEN_PROFILES_PREVIEW);
    ipcMain.removeHandler(IPC.TOKEN_PROFILES_APPLY);
  };
}
