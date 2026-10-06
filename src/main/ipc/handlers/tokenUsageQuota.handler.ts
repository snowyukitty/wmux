import { ipcMain } from 'electron';
import * as os from 'os';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import {
  type AgySensorInstallResult,
  type AgySensorStatus,
  type QuotaReadRequest,
  type QuotaReadResult,
} from '../../../shared/tokenUsage/quotaTypes';
import { QuotaService } from '../../quota/QuotaService';
import { createCodexAccountStatusReader } from '../../../daemon/web/codexAccountStatus';

let defaultQuotaService: QuotaService | null = null;

export function getDefaultQuotaService(): QuotaService {
  if (!defaultQuotaService) {
    const codexReader = createCodexAccountStatusReader();
    defaultQuotaService = new QuotaService({
      homeDir: os.homedir(),
      readCodex: async (codeHome) => {
        try {
          return await codexReader.read(codeHome);
        } catch {
          return null;
        }
      },
    });
  }
  return defaultQuotaService;
}

export function registerTokenUsageQuotaHandlers(service?: QuotaService): () => void {
  const svc = service ?? getDefaultQuotaService();

  ipcMain.removeHandler(IPC.TOKEN_QUOTA_READ);
  ipcMain.handle(
    IPC.TOKEN_QUOTA_READ,
    wrapHandler(IPC.TOKEN_QUOTA_READ, async (_event, request?: QuotaReadRequest): Promise<QuotaReadResult> => {
      return svc.readQuota(request);
    }),
  );

  ipcMain.removeHandler(IPC.TOKEN_QUOTA_SENSOR_STATUS);
  ipcMain.handle(
    IPC.TOKEN_QUOTA_SENSOR_STATUS,
    wrapHandler(IPC.TOKEN_QUOTA_SENSOR_STATUS, async (): Promise<AgySensorStatus> => {
      return svc.getAgySensorStatus();
    }),
  );

  ipcMain.removeHandler(IPC.TOKEN_QUOTA_SENSOR_INSTALL);
  ipcMain.handle(
    IPC.TOKEN_QUOTA_SENSOR_INSTALL,
    wrapHandler(IPC.TOKEN_QUOTA_SENSOR_INSTALL, async (): Promise<AgySensorInstallResult> => {
      return svc.installAgySensor();
    }),
  );

  return () => {
    ipcMain.removeHandler(IPC.TOKEN_QUOTA_READ);
    ipcMain.removeHandler(IPC.TOKEN_QUOTA_SENSOR_STATUS);
    ipcMain.removeHandler(IPC.TOKEN_QUOTA_SENSOR_INSTALL);
  };
}
