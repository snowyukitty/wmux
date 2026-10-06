import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { ModelCatalog } from '../../agents/ModelCatalog';
import type { ModelCatalogResult } from '../../../shared/modelCatalog';
import { trustAgyForSpawningFolder, type AgyTrustResult } from '../../agents/agyTrust';

// One catalog for the app's lifetime. registerAllHandlers re-runs on boot and on
// every daemon (re)connect; a catalog built per registration lost the in-memory
// failure TTL and the in-flight dedup each time. Created lazily, on the first
// registration, so importing this module stays side-effect free.
let sharedCatalog: ModelCatalog | undefined;

export function sharedModelCatalog(): ModelCatalog {
  sharedCatalog ??= new ModelCatalog();
  return sharedCatalog;
}

/** Agent CLI model discovery for Settings (see main/agents/ModelCatalog). */
export function registerAgentModelsHandlers(catalog: ModelCatalog = sharedModelCatalog()): void {
  ipcMain.removeHandler(IPC.AGENT_MODELS_LIST);
  ipcMain.handle(
    IPC.AGENT_MODELS_LIST,
    wrapHandler(IPC.AGENT_MODELS_LIST, (_event: Electron.IpcMainInvokeEvent, raw: unknown): Promise<ModelCatalogResult> => {
      const req = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      const agent = typeof req.agent === 'string' ? req.agent.trim().toLowerCase() : '';
      return catalog.list(agent, { refresh: req.refresh === true });
    }),
  );
  // Only a folder FanOutService is launching a worker in right now is accepted.
  ipcMain.removeHandler(IPC.AGY_TRUST_FOLDER);
  ipcMain.handle(
    IPC.AGY_TRUST_FOLDER,
    wrapHandler(IPC.AGY_TRUST_FOLDER, (_event: Electron.IpcMainInvokeEvent, raw: unknown): AgyTrustResult => {
      const folder = typeof raw === 'string' ? raw : '';
      if (!folder) return { ok: false, reason: 'no folder' };
      return trustAgyForSpawningFolder(folder);
    }),
  );
}
