import * as path from 'path';
import {
  QUOTA_PROVIDERS,
  type AgySensorInstallResult,
  type AgySensorStatus,
  type ProviderQuota,
  type ProviderQuotaReading,
  type QuotaProviderId,
  type QuotaReadRequest,
  type QuotaReadResult,
  type QuotaWindowDelta,
} from '../../shared/tokenUsage/quotaTypes';
import type { LoadResult } from '../claude/claudeCredential';
import type { UsageSnapshot } from '../claude/UsageApi';
import type { CodexAccountStatus } from '../../shared/phoneCodexAccountStatus';
import { readClaudeQuota } from './claudeAdapter';
import { readCodexQuota, type CodexStatusReader } from './codexAdapter';
import {
  checkAgySensorStatus,
  installAgySensor,
  readAgyQuota,
} from './agyAdapter';
import {
  lastCheckKey,
  loadLastCheckStore,
  saveLastCheckStore,
  type LastCheckIo,
  type LastCheckStoreData,
} from './lastCheckStore';

import type { TranscriptScanDeps, TranscriptScanResult } from './transcripts';

export interface QuotaServiceDeps {
  now?: () => number;
  homeDir?: string;
  loadClaudeCred?: (configDir?: string) => Promise<LoadResult>;
  fetchClaude?: (token: string) => Promise<UsageSnapshot>;
  readCodex?: CodexStatusReader;
  scanClaudeTranscripts?: (dir: string, deps?: TranscriptScanDeps) => Promise<TranscriptScanResult>;
  scanCodexTranscripts?: (dir: string, deps?: TranscriptScanDeps) => Promise<TranscriptScanResult>;
  transcriptScanDeps?: TranscriptScanDeps;
  readAgyFile?: (filePath: string) => Promise<string | null>;
  readAgySettings?: (filePath: string) => Promise<string | null>;
  installAgySensorFn?: (
    homeDir: string,
  ) => { ok: boolean; action: string; error?: string };
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  unlink?: (filePath: string) => Promise<void>;
  mkdir?: (dirPath: string) => Promise<void>;
}

export class QuotaService {
  private readonly deps: QuotaServiceDeps;

  constructor(deps: QuotaServiceDeps = {}) {
    this.deps = deps;
  }

  private get now(): () => number {
    return this.deps.now ?? Date.now;
  }

  private get homeDir(): string {
    return this.deps.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  }

  private get lastCheckIo(): LastCheckIo {
    return {
      readFile: this.deps.readFile,
      writeFile: this.deps.writeFile,
      rename: this.deps.rename,
      unlink: this.deps.unlink,
      mkdir: this.deps.mkdir,
    };
  }

  async readQuota(request?: QuotaReadRequest): Promise<QuotaReadResult> {
    const wanted = request?.providers && request.providers.length > 0
      ? request.providers
      : [...QUOTA_PROVIDERS];

    const quotaDir = path.join(this.homeDir, '.wmux', 'quota');
    let lastCheckStore: LastCheckStoreData = {};
    try {
      lastCheckStore = await loadLastCheckStore(quotaDir, this.lastCheckIo);
    } catch {
      lastCheckStore = {};
    }

    const readings: ProviderQuotaReading[] = [];

    for (const provider of wanted) {
      let quota: ProviderQuota;
      try {
        if (provider === 'claude') {
          quota = await readClaudeQuota({
            now: this.now,
            homeDir: this.homeDir,
            loadCredential: this.deps.loadClaudeCred,
            fetchClaude: this.deps.fetchClaude,
            scanTranscripts: this.deps.scanClaudeTranscripts,
            transcriptScanDeps: this.deps.transcriptScanDeps,
          });
        } else if (provider === 'codex') {
          quota = await readCodexQuota({
            now: this.now,
            homeDir: this.homeDir,
            readCodex: this.deps.readCodex,
            scanTranscripts: this.deps.scanCodexTranscripts,
            transcriptScanDeps: this.deps.transcriptScanDeps,
          });
        } else if (provider === 'agy') {
          quota = await readAgyQuota({
            now: this.now,
            homeDir: this.homeDir,
            readAgyFile: this.deps.readAgyFile,
            readAgySettings: this.deps.readAgySettings,
            installSensorFn: this.deps.installAgySensorFn,
          });
        } else {
          quota = {
            provider,
            status: 'unavailable',
            windows: [],
            planLabel: null,
            creditsLabel: null,
            capturedAtMs: null,
            fetchedAtMs: this.now(),
            contextUsage: null,
            avgTokensPerMessage: null,
            message: `Unknown provider: ${provider}`,
          };
        }
      } catch (err) {
        quota = {
          provider,
          status: 'error',
          windows: [],
          planLabel: null,
          creditsLabel: null,
          capturedAtMs: null,
          fetchedAtMs: this.now(),
          contextUsage: null,
          avgTokensPerMessage: null,
          message: 'Unexpected error reading quota.',
        };
      }

      let deltas: QuotaWindowDelta[] = [];
      try {
        for (const window of quota.windows) {
          const key = lastCheckKey(provider, window.id);
          const prev = lastCheckStore[key];

          if (prev) {
            const previousCheckedAtMs = prev.checkedAtMs;
            const windowReset =
              prev.resetAtMs !== null &&
              window.resetAtMs !== null &&
              window.resetAtMs - prev.resetAtMs > 60_000;

            const agyUnchanged =
              provider === 'agy' &&
              prev.quotaCapturedAtMs != null &&
              quota.capturedAtMs != null &&
              prev.quotaCapturedAtMs === quota.capturedAtMs;

            let deltaPct: number | null = null;
            if (!windowReset && !agyUnchanged && window.usedPct !== null && prev.usedPct !== null) {
              deltaPct = window.usedPct - prev.usedPct;
            }

            deltas.push({
              windowId: window.id,
              deltaPct,
              windowReset,
              previousCheckedAtMs,
            });
          } else {
            deltas.push({
              windowId: window.id,
              deltaPct: null,
              windowReset: false,
              previousCheckedAtMs: 0,
            });
          }
        }
      } catch {
        deltas = [];
        for (const w of quota.windows) {
          try {
            deltas.push({
              windowId: w.id,
              deltaPct: null,
              windowReset: false,
              previousCheckedAtMs: 0,
            });
          } catch {
            deltas.push({
              windowId: 'unknown',
              deltaPct: null,
              windowReset: false,
              previousCheckedAtMs: 0,
            });
          }
        }
      }

      readings.push({ quota, deltas });
    }

    // Persist new snapshots for successful windows
    for (const reading of readings) {
      if (reading.quota.windows.length > 0) {
        for (const window of reading.quota.windows) {
          try {
            const key = lastCheckKey(reading.quota.provider, window.id);
            const prev = lastCheckStore[key];
            if (
              reading.quota.provider === 'agy' &&
              prev?.quotaCapturedAtMs &&
              reading.quota.capturedAtMs &&
              prev.quotaCapturedAtMs === reading.quota.capturedAtMs
            ) {
              continue;
            }
            lastCheckStore[key] = {
              usedPct: window.usedPct,
              resetAtMs: window.resetAtMs,
              checkedAtMs: reading.quota.fetchedAtMs,
              quotaCapturedAtMs: reading.quota.capturedAtMs,
            };
          } catch {
            // ignore snapshot storage errors per window
          }
        }
      }
    }

    try {
      await saveLastCheckStore(quotaDir, lastCheckStore, this.lastCheckIo);
    } catch {
      // Ignore persistence errors on read
    }

    return { readings };
  }

  async getAgySensorStatus(): Promise<AgySensorStatus> {
    return checkAgySensorStatus({
      homeDir: this.homeDir,
      readAgyFile: this.deps.readAgyFile,
      readAgySettings: this.deps.readAgySettings,
    });
  }

  async installAgySensor(): Promise<AgySensorInstallResult> {
    return installAgySensor({
      homeDir: this.homeDir,
      readAgyFile: this.deps.readAgyFile,
      readAgySettings: this.deps.readAgySettings,
      installSensorFn: this.deps.installAgySensorFn,
    });
  }
}
