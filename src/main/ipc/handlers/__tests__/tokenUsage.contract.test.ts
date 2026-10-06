import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

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
import { registerTokenUsageQuotaHandlers } from '../tokenUsageQuota.handler';
import { registerTokenUsageSurfaceHandlers } from '../tokenUsageSurface.handler';
import { SURFACE_CAPABILITIES, capabilityFor } from '../../../../shared/tokenUsage/capabilities';
import type { QuotaReadRequest, QuotaReadResult } from '../../../../shared/tokenUsage/quotaTypes';
import type { QuotaService } from '../../../quota/QuotaService';
import type { ProviderInventory } from '../../../../shared/tokenUsage/surfaceTypes';

const CHANNELS = [
  IPC.TOKEN_QUOTA_READ,
  IPC.TOKEN_QUOTA_SENSOR_STATUS,
  IPC.TOKEN_QUOTA_SENSOR_INSTALL,
  IPC.TOKEN_SURFACE_INVENTORY,
  IPC.TOKEN_SURFACE_PREVIEW,
  IPC.TOKEN_SURFACE_APPLY,
];

function fakeQuotaService(): QuotaService {
  return {
    readQuota: vi.fn(async () => ({ readings: [] })),
    getAgySensorStatus: vi.fn(),
    installAgySensor: vi.fn(),
  } as unknown as QuotaService;
}

async function handlers() {
  const electron = (await import('electron')) as unknown as {
    __handlers: Map<string, (...args: unknown[]) => unknown>;
  };
  return electron.__handlers;
}

describe('token usage IPC contract', () => {
  it('uses distinct channel names', () => {
    expect(new Set(CHANNELS).size).toBe(CHANNELS.length);
  });

  it('registers every channel and removes them on cleanup', async () => {
    const cleanups = [registerTokenUsageQuotaHandlers(fakeQuotaService()), registerTokenUsageSurfaceHandlers()];
    const map = await handlers();
    for (const channel of CHANNELS) expect(map.has(channel)).toBe(true);
    for (const cleanup of cleanups) cleanup();
    for (const channel of CHANNELS) expect(map.has(channel)).toBe(false);
  });

  it('quota read delegates to the injected service and never builds a default one', async () => {
    const service = fakeQuotaService();
    const cleanup = registerTokenUsageQuotaHandlers(service);
    const map = await handlers();
    const request: QuotaReadRequest = { providers: ['codex'] };
    const result = (await map.get(IPC.TOKEN_QUOTA_READ)!({}, request)) as QuotaReadResult;
    expect(service.readQuota).toHaveBeenCalledWith(request);
    expect(result.readings).toEqual([]);
    cleanup();
  });

  it('inventory handler returns reader result and rejects unknown provider', async () => {
    const mockDeps = {
      homeDir: '/tmp/nonexistent-test-home',
      run: async () => '1.2.14',
    };
    const cleanup = registerTokenUsageSurfaceHandlers(mockDeps);
    const map = await handlers();
    const inv = (await map.get(IPC.TOKEN_SURFACE_INVENTORY)!({}, { provider: 'agy' })) as ProviderInventory;
    expect(inv.provider).toBe('agy');
    expect(inv.versionSupported).toBe(true);
    expect(inv.writable).toBe(true);

    await expect(
      map.get(IPC.TOKEN_SURFACE_INVENTORY)!({}, { provider: 'unknown' as any }),
    ).rejects.toThrow('Unknown provider');

    cleanup();
  });

  it('reconcile handler returns reconcile result and rejects unknown provider', async () => {
    const mockDeps = {
      homeDir: '/tmp/nonexistent-test-home',
      run: async () => '1.2.14',
    };
    const cleanup = registerTokenUsageSurfaceHandlers(mockDeps);
    const map = await handlers();
    const result = (await map.get(IPC.TOKEN_SURFACE_RECONCILE)!({}, { provider: 'agy' })) as any;
    expect(result).toHaveProperty('newItems');
    expect(result).toHaveProperty('removedItems');
    expect(result).toHaveProperty('driftedItems');
    expect(result).toHaveProperty('driftedCount');
    expect(result).toHaveProperty('truncated');

    await expect(
      map.get(IPC.TOKEN_SURFACE_RECONCILE)!({}, { provider: 'unknown' as any }),
    ).rejects.toThrow('Unknown provider');

    cleanup();
  });
});

describe('surface capabilities (phase-2 spike)', () => {
  it('covers every surface kind for every provider exactly once', () => {
    for (const [provider, caps] of Object.entries(SURFACE_CAPABILITIES)) {
      const kinds = caps.map((c) => c.kind);
      expect(new Set(kinds).size, provider).toBe(kinds.length);
      expect(kinds).toEqual(expect.arrayContaining(['mcp-server', 'plugin', 'skill', 'hook']));
    }
  });

  it('records the verified spike results', () => {
    expect(capabilityFor('agy', 'skill')?.mechanism).toMatch(/exact directory names/);
    expect(capabilityFor('agy', 'plugin')?.status).toBe('verified');
    expect(capabilityFor('agy', 'hook')?.status).toBe('verified');
    expect(capabilityFor('codex', 'skill')?.mechanism).toMatch(/SKILL\.md/);
  });
});
