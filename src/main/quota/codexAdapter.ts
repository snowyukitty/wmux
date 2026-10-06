import * as path from 'path';
import type { ProviderQuota, QuotaWindow } from '../../shared/tokenUsage/quotaTypes';
import type { CodexAccountStatus } from '../../shared/phoneCodexAccountStatus';
import { scanCodexTranscripts, type TranscriptScanDeps, type TranscriptScanResult } from './transcripts';
import { readCodexRolloutLimits, type RolloutLimits } from './codexRollout';

export type CodexStatusReader = (codeHome: string) => Promise<CodexAccountStatus | null>;

export interface CodexAdapterDeps {
  now?: () => number;
  homeDir?: string;
  sessionsDir?: string;
  scanTranscripts?: (dir: string, deps?: TranscriptScanDeps) => Promise<TranscriptScanResult>;
  transcriptScanDeps?: TranscriptScanDeps;
  readCodex?: CodexStatusReader;
  /** Codex's own limits from its session files; the fallback when no app-server answers. */
  readRollout?: (sessionsDir: string) => Promise<RolloutLimits | null>;
}

export function codexWindowLabel(minutes: number | null, fallback: string): string {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return 'weekly';
  if (minutes === 60) return '1h';
  if (minutes === 1440) return 'daily';
  if (minutes !== null && minutes > 0) {
    if (minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return fallback;
}

/** Windows from a session-file reading. A window whose reset has already passed
 *  rolled over after Codex wrote it, so its percentage no longer says anything. */
export function windowsFromRollout(limits: RolloutLimits, nowMs: number): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  const seen = new Set<string>();
  for (const [slot, w] of [['primary', limits.primary], ['secondary', limits.secondary]] as const) {
    if (!w || (w.resetsAtMs !== null && w.resetsAtMs <= nowMs)) continue;
    const label = codexWindowLabel(w.windowMinutes, slot === 'primary' ? 'Primary' : 'Secondary');
    const key = label.toLowerCase();
    out.push({
      id: seen.has(key) ? `${slot}-${key}` : key,
      label,
      usedPct: w.usedPercent,
      resetAtMs: w.resetsAtMs,
      windowMins: w.windowMinutes,
    });
    seen.add(key);
  }
  return out;
}

export async function readCodexQuota(deps: CodexAdapterDeps = {}): Promise<ProviderQuota> {
  const now = deps.now ?? Date.now;
  const home = deps.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const codeHome = path.join(home, '.codex');

  let avgTokensPerMessage: number | null = null;
  let scanDetails: { sampleSize?: number; partial?: boolean } | undefined;
  try {
    const sessionsDir = deps.sessionsDir ?? path.join(codeHome, 'sessions');
    const scanFn = deps.scanTranscripts ?? scanCodexTranscripts;
    const scanResult = await scanFn(sessionsDir, deps.transcriptScanDeps);
    if (scanResult && scanResult.sampleSize > 0 && scanResult.average !== null) {
      avgTokensPerMessage = Math.round(scanResult.average);
      scanDetails = { sampleSize: scanResult.sampleSize, partial: scanResult.partial };
    }
  } catch {
    avgTokensPerMessage = null;
  }

  const base: Omit<ProviderQuota, 'status' | 'windows' | 'planLabel' | 'creditsLabel' | 'message'> = {
    provider: 'codex',
    capturedAtMs: null,
    fetchedAtMs: now(),
    contextUsage: null,
    avgTokensPerMessage,
  };

  // No app-server answering: Codex still records the account's limits in every
  // session file it writes, so read the newest of those instead.
  const fromSessionFiles = async (): Promise<ProviderQuota | null> => {
    try {
      const sessionsDir = deps.sessionsDir ?? path.join(codeHome, 'sessions');
      const read = deps.readRollout ?? ((dir: string) => readCodexRolloutLimits(dir, deps.transcriptScanDeps));
      const limits = await read(sessionsDir);
      if (!limits) return null;
      const windows = windowsFromRollout(limits, now());
      if (windows.length === 0) return null;
      const result: ProviderQuota = {
        ...base,
        status: 'ok',
        windows,
        planLabel: null,
        creditsLabel: null,
        capturedAtMs: limits.capturedAtMs,
        message: null,
      };
      if (scanDetails) Object.assign(result, scanDetails);
      return result;
    } catch {
      return null;
    }
  };

  if (!deps.readCodex) {
    return (
      (await fromSessionFiles()) ?? {
        ...base,
        status: 'unavailable',
        windows: [],
        planLabel: null,
        creditsLabel: null,
        message: 'Codex account status reader not provided.',
      }
    );
  }

  let status: CodexAccountStatus | null = null;
  try {
    status = await deps.readCodex(codeHome);
  } catch {
    status = null;
  }

  if (!status) {
    return (
      (await fromSessionFiles()) ?? {
        ...base,
        status: 'unavailable',
        windows: [],
        planLabel: null,
        creditsLabel: null,
        message: 'Codex app-server is not running, and no recent Codex session has recorded its limits.',
      }
    );
  }

  if (status.auth.state === 'signed-out') {
    return {
      ...base,
      status: 'unauthorized',
      windows: [],
      planLabel: null,
      creditsLabel: null,
      message: 'Codex account signed out.',
    };
  }

  if (status.auth.method === 'apikey') {
    return {
      ...base,
      status: 'unavailable',
      windows: [],
      planLabel: null,
      creditsLabel: null,
      message: 'API key accounts do not report plan rate limits.',
    };
  }

  const rateLimits = status.rateLimits;
  const planLabel = rateLimits?.planType ?? (status as unknown as Record<string, unknown>).planType as string | null ?? null;
  const creditsLabel =
    (rateLimits as Record<string, unknown> | null)?.creditsLabel as string | null ??
    (status as unknown as Record<string, unknown>).creditsLabel as string | null ??
    null;

  if (!rateLimits) {
    return {
      ...base,
      status: 'no-data',
      windows: [],
      planLabel,
      creditsLabel,
      message: 'No rate limit data available.',
    };
  }

  const buckets = rateLimits.buckets;
  if (!Array.isArray(buckets) || buckets.length === 0) {
    return {
      ...base,
      status: 'no-data',
      windows: [],
      planLabel,
      creditsLabel,
      message: 'No rate limit buckets reported.',
    };
  }

  const windows: QuotaWindow[] = [];
  const seenIds = new Set<string>();

  for (const bucket of buckets) {
    const bucketPrefix = buckets.length > 1 && bucket.limitId ? `${bucket.limitId}-` : '';

    if (bucket.primary) {
      const label = codexWindowLabel(bucket.primary.windowMinutes, 'Primary');
      let id = `${bucketPrefix}${label.toLowerCase()}`;
      if (seenIds.has(id)) id = `${bucketPrefix}primary-${label.toLowerCase()}`;
      if (seenIds.has(id)) id = `${id}-${windows.length}`;
      seenIds.add(id);

      windows.push({
        id,
        label,
        usedPct: bucket.primary.usedPercent,
        resetAtMs: bucket.primary.resetsAt,
        windowMins: bucket.primary.windowMinutes,
      });
    }

    if (bucket.secondary) {
      const label = codexWindowLabel(bucket.secondary.windowMinutes, 'Secondary');
      let id = `${bucketPrefix}${label.toLowerCase()}`;
      if (seenIds.has(id)) id = `${bucketPrefix}secondary-${label.toLowerCase()}`;
      if (seenIds.has(id)) id = `${id}-${windows.length}`;
      seenIds.add(id);

      windows.push({
        id,
        label,
        usedPct: bucket.secondary.usedPercent,
        resetAtMs: bucket.secondary.resetsAt,
        windowMins: bucket.secondary.windowMinutes,
      });
    }
  }

  if (windows.length === 0) {
    return {
      ...base,
      status: 'no-data',
      windows: [],
      planLabel,
      creditsLabel,
      message: 'No rate limit windows reported.',
    };
  }

  const result: ProviderQuota = {
    ...base,
    status: 'ok',
    windows,
    planLabel,
    creditsLabel,
    fetchedAtMs: status.fetchedAt || base.fetchedAtMs,
    message: null,
  };
  if (scanDetails) {
    Object.assign(result, scanDetails);
  }
  return result;
}
