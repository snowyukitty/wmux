import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import type {
  ProviderInventory,
  SurfaceApplyResult,
  SurfaceChangeRequest,
  SurfaceInventoryRequest,
  SurfacePreview,
} from '../../../shared/tokenUsage/surfaceTypes';

import { readInventory, type InventoryDeps } from '../../surfaces/inventory';
import {
  applySurfaceChanges,
  previewSurfaceChanges,
  type SurfaceChangeOptions,
} from '../../surfaces/writers';
import { reconcileSurface, type SurfaceReconcileResult } from '../../surfaces/reconcile';

const PROVIDERS = ['claude', 'codex', 'agy'];

function assertProvider(provider: unknown): void {
  if (typeof provider !== 'string' || !PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider: ${String(provider)}`);
  }
}

function assertChangeRequest(request: SurfaceChangeRequest): void {
  assertProvider(request?.provider);
  const valid =
    Array.isArray(request.changes) &&
    request.changes.every((c) => typeof c?.itemId === 'string' && typeof c?.enabled === 'boolean');
  if (!valid) throw new Error('Invalid change request');
}

export function registerTokenUsageSurfaceHandlers(
  deps?: Partial<InventoryDeps>,
  writerOptions: SurfaceChangeOptions = {},
): () => void {
  const options: SurfaceChangeOptions = { inventoryDeps: deps, ...writerOptions };

  ipcMain.removeHandler(IPC.TOKEN_SURFACE_INVENTORY);
  ipcMain.handle(
    IPC.TOKEN_SURFACE_INVENTORY,
    wrapHandler(
      IPC.TOKEN_SURFACE_INVENTORY,
      async (_event, request: SurfaceInventoryRequest): Promise<ProviderInventory> => {
        assertProvider(request?.provider);
        return readInventory(request.provider, deps);
      },
    ),
  );

  ipcMain.removeHandler(IPC.TOKEN_SURFACE_PREVIEW);
  ipcMain.handle(
    IPC.TOKEN_SURFACE_PREVIEW,
    wrapHandler(IPC.TOKEN_SURFACE_PREVIEW, async (_event, request: SurfaceChangeRequest): Promise<SurfacePreview> => {
      assertChangeRequest(request);
      return previewSurfaceChanges(request, options);
    }),
  );

  ipcMain.removeHandler(IPC.TOKEN_SURFACE_APPLY);
  ipcMain.handle(
    IPC.TOKEN_SURFACE_APPLY,
    wrapHandler(IPC.TOKEN_SURFACE_APPLY, async (_event, request: SurfaceChangeRequest): Promise<SurfaceApplyResult> => {
      assertChangeRequest(request);
      return applySurfaceChanges(request, options);
    }),
  );

  ipcMain.removeHandler(IPC.TOKEN_SURFACE_RECONCILE);
  ipcMain.handle(
    IPC.TOKEN_SURFACE_RECONCILE,
    wrapHandler(IPC.TOKEN_SURFACE_RECONCILE, async (_event, request: { provider: any }): Promise<SurfaceReconcileResult> => {
      assertProvider(request?.provider);
      return reconcileSurface(request.provider, {
        inventoryDeps: deps,
        storePath: writerOptions.deps?.surfacesStorePath,
      });
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.TOKEN_SURFACE_INVENTORY);
    ipcMain.removeHandler(IPC.TOKEN_SURFACE_PREVIEW);
    ipcMain.removeHandler(IPC.TOKEN_SURFACE_APPLY);
    ipcMain.removeHandler(IPC.TOKEN_SURFACE_RECONCILE);
  };
}
