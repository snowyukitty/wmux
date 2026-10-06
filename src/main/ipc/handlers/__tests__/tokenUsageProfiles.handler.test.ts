import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  return { ipcMain, __handlers: handlers };
});

import { IPC } from '../../../../shared/constants';
import { registerTokenUsageProfilesHandlers } from '../tokenUsageProfiles.handler';
import * as serviceModule from '../../../surfaces/profiles/surfaceProfilesService';

async function getHandlers() {
  const electron = (await import('electron')) as unknown as {
    __handlers: Map<string, (...args: unknown[]) => unknown>;
  };
  return electron.__handlers;
}

const CHANNELS = [
  IPC.TOKEN_PROFILES_LIST,
  IPC.TOKEN_PROFILES_SAVE,
  IPC.TOKEN_PROFILES_DELETE,
  IPC.TOKEN_PROFILES_PREVIEW,
  IPC.TOKEN_PROFILES_APPLY,
];

describe('tokenUsageProfiles handler', () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = registerTokenUsageProfilesHandlers();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('registers all 5 profile channels and removes them on cleanup', async () => {
    const map = await getHandlers();
    for (const channel of CHANNELS) {
      expect(map.has(channel)).toBe(true);
    }

    cleanup();
    for (const channel of CHANNELS) {
      expect(map.has(channel)).toBe(false);
    }
  });

  describe('save validation and fixed error text', () => {
    it('rejects invalid payload or missing/empty name with fixed error sentences', async () => {
      const map = await getHandlers();
      const handle = map.get(IPC.TOKEN_PROFILES_SAVE)!;

      await expect(handle({}, null)).rejects.toThrow('Invalid save profile request.');
      await expect(handle({}, 'not-an-object')).rejects.toThrow('Invalid save profile request.');
      await expect(handle({}, {})).rejects.toThrow('Profile name must be a string.');
      await expect(handle({}, { name: '' })).rejects.toThrow('Profile name must be between 1 and 40 characters.');
      await expect(handle({}, { name: '   ' })).rejects.toThrow('Profile name must be between 1 and 40 characters.');
      await expect(handle({}, { name: 'a'.repeat(41) })).rejects.toThrow(
        'Profile name must be between 1 and 40 characters.',
      );
    });

    it('rejects invalid providers with fixed error sentences', async () => {
      const map = await getHandlers();
      const handle = map.get(IPC.TOKEN_PROFILES_SAVE)!;

      await expect(handle({}, { name: 'Valid', providers: 'not-array' })).rejects.toThrow('Providers must be an array.');
      await expect(handle({}, { name: 'Valid', providers: ['unknown-provider'] })).rejects.toThrow('Unknown provider.');
    });

    it('returns fixed sentence on duplicate name or limit reached without leaking exception text', async () => {
      const map = await getHandlers();
      const handle = map.get(IPC.TOKEN_PROFILES_SAVE)!;

      vi.spyOn(serviceModule, 'saveProfile').mockRejectedValueOnce(
        new Error('A profile with this name already exists.'),
      );
      await expect(handle({}, { name: 'Duplicate' })).rejects.toThrow('A profile with this name already exists.');

      vi.spyOn(serviceModule, 'saveProfile').mockRejectedValueOnce(
        new Error('Maximum number of profiles (50) reached.'),
      );
      await expect(handle({}, { name: 'Over Limit' })).rejects.toThrow('Maximum number of profiles (50) reached.');

      vi.spyOn(serviceModule, 'saveProfile').mockRejectedValueOnce(
        new Error('Storage version is not supported.'),
      );
      await expect(handle({}, { name: 'Storage Error' })).rejects.toThrow('Storage version is not supported.');

      vi.spyOn(serviceModule, 'saveProfile').mockRejectedValueOnce(
        new Error('ENOENT: C:\\secret\\path\\file.json open failed'),
      );
      await expect(handle({}, { name: 'Other Error' })).rejects.toThrow('Failed to save surface profile.');
    });
  });

  describe('delete validation and fixed error text', () => {
    it('rejects invalid id with fixed error sentence', async () => {
      const map = await getHandlers();
      const handle = map.get(IPC.TOKEN_PROFILES_DELETE)!;

      await expect(handle({}, null)).rejects.toThrow('Invalid delete profile request.');
      await expect(handle({}, {})).rejects.toThrow('Profile id must be a non-empty string.');
      await expect(handle({}, { id: '' })).rejects.toThrow('Profile id must be a non-empty string.');
      await expect(handle({}, { id: '   ' })).rejects.toThrow('Profile id must be a non-empty string.');
    });

    it('calls deleteProfile and handles errors cleanly', async () => {
      const map = await getHandlers();
      const handle = map.get(IPC.TOKEN_PROFILES_DELETE)!;

      vi.spyOn(serviceModule, 'deleteProfile').mockResolvedValueOnce(true);
      const res = await handle({}, { id: 'prof-1' });
      expect(res).toBe(true);

      vi.spyOn(serviceModule, 'deleteProfile').mockRejectedValueOnce(new Error('disk fault /path/to/file'));
      await expect(handle({}, { id: 'prof-1' })).rejects.toThrow('Failed to delete surface profile.');
    });
  });

  describe('preview validation and fixed error text', () => {
    it('validates id and maps errors to fixed sentences', async () => {
      const map = await getHandlers();
      const handle = map.get(IPC.TOKEN_PROFILES_PREVIEW)!;

      await expect(handle({}, {})).rejects.toThrow('Profile id must be a non-empty string.');

      vi.spyOn(serviceModule, 'previewProfile').mockRejectedValueOnce(new Error('Profile not found.'));
      await expect(handle({}, { id: 'nonexistent' })).rejects.toThrow('Profile not found.');

      vi.spyOn(serviceModule, 'previewProfile').mockRejectedValueOnce(new Error('random disk crash'));
      await expect(handle({}, { id: 'some-id' })).rejects.toThrow('Failed to preview surface profile.');
    });
  });

  describe('apply validation and fixed error text', () => {
    it('validates id, ignores allowWmuxRequired: true, and maps errors to fixed sentences', async () => {
      const map = await getHandlers();
      const handle = map.get(IPC.TOKEN_PROFILES_APPLY)!;

      await expect(handle({}, {})).rejects.toThrow('Profile id must be a non-empty string.');

      const applySpy = vi.spyOn(serviceModule, 'applyProfile').mockResolvedValueOnce({
        ok: true,
        providers: {},
        missing: { count: 0, firstFewIds: [] },
        newItems: 0,
      });

      // Request carrying allowWmuxRequired: true is ignored (not passed to service)
      await handle({}, { id: 'p1', allowWmuxRequired: true });
      expect(applySpy).toHaveBeenCalledWith('p1', undefined);

      vi.spyOn(serviceModule, 'applyProfile').mockRejectedValueOnce(new Error('Profile not found.'));
      await expect(handle({}, { id: 'nonexistent' })).rejects.toThrow('Profile not found.');

      vi.spyOn(serviceModule, 'applyProfile').mockRejectedValueOnce(new Error('write error'));
      await expect(handle({}, { id: 'some-id' })).rejects.toThrow('Failed to apply surface profile.');
    });
  });

  describe('list handler', () => {
    it('delegates to listProfiles', async () => {
      const map = await getHandlers();
      const handle = map.get(IPC.TOKEN_PROFILES_LIST)!;

      vi.spyOn(serviceModule, 'listProfiles').mockResolvedValueOnce([
        { id: '1', name: 'Profile 1', createdAt: 1000, providers: {} },
      ]);
      const list = await handle({});
      expect(list).toEqual([{ id: '1', name: 'Profile 1', createdAt: 1000, providers: {} }]);
    });
  });
});
