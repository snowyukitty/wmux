import * as fs from 'fs';
import * as path from 'path';
import type {
  AgySensorInstallResult,
  AgySensorStatus,
  ProviderQuota,
  QuotaWindow,
} from '../../shared/tokenUsage/quotaTypes';
import {
  classifyAgyStatusLine,
  installAgyQuotaSensor,
  type InstallAgyQuotaSensorOptions,
} from './installAgyQuotaSensor';

export interface AgyAdapterDeps {
  now?: () => number;
  homeDir?: string;
  readAgyFile?: (filePath: string) => Promise<string | null>;
  readAgySettings?: (filePath: string) => Promise<string | null>;
  installSensorFn?: (
    homeDir: string,
    options?: InstallAgyQuotaSensorOptions,
  ) => { ok: boolean; action: string; error?: string };
}

export function formatAgyBucketLabel(bucket: string): string {
  const parts = bucket.split(/[-_]/);
  if (parts.length === 0) return bucket;
  return parts
    .map((p, idx) => {
      if (idx === 0 && p.toLowerCase() === 'gemini') return 'Gemini';
      if (idx === 0 && p.toLowerCase() === '3p') return '3p';
      if (p === '5h') return '5h';
      if (p === 'weekly') return 'weekly';
      if (idx === 0) return p.charAt(0).toUpperCase() + p.slice(1);
      return p;
    })
    .join(' ');
}

interface StoredAgyBucket {
  remaining_fraction?: number;
  reset_time?: string;
  reset_in_seconds?: number;
}

interface StoredAgyRecord {
  quota?: Record<string, StoredAgyBucket>;
  quotaCapturedAtMs?: number;
  plan_tier?: string;
  model?: { id?: string };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
  };
  conversation_id?: string;
  version?: string;
  capturedAtMs?: number;
}

export async function checkAgySensorStatus(deps: AgyAdapterDeps = {}): Promise<AgySensorStatus> {
  const home = deps.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const settingsPath = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  const quotaPath = path.join(home, '.wmux', 'quota', 'agy.json');

  let hasData = false;
  try {
    const rawQuota = deps.readAgyFile
      ? await deps.readAgyFile(quotaPath)
      : await fs.promises.readFile(quotaPath, 'utf8').catch(() => null);
    if (rawQuota) {
      const parsed = JSON.parse(rawQuota) as StoredAgyRecord;
      if (parsed && parsed.quota && typeof parsed.quota === 'object' && Object.keys(parsed.quota).length > 0) {
        hasData = true;
      }
    }
  } catch {
    hasData = false;
  }

  let rawSettings: string | null = null;
  try {
    rawSettings = deps.readAgySettings
      ? await deps.readAgySettings(settingsPath)
      : await fs.promises.readFile(settingsPath, 'utf8').catch(() => null);
  } catch {
    return {
      state: 'error',
      settingsPath,
      hasData,
      message: 'Failed to read Antigravity settings.json.',
    };
  }

  if (rawSettings === null || rawSettings.trim().length === 0) {
    return {
      state: 'missing',
      settingsPath,
      hasData,
      message: 'Antigravity settings.json not found or empty.',
    };
  }

  let settingsObj: Record<string, unknown>;
  try {
    settingsObj = JSON.parse(rawSettings) as Record<string, unknown>;
  } catch {
    return {
      state: 'error',
      settingsPath,
      hasData,
      message: 'Failed to parse Antigravity settings.json.',
    };
  }

  const kind = classifyAgyStatusLine(settingsObj);
  if (kind === 'agy-sink') {
    return {
      state: 'installed',
      settingsPath,
      hasData,
      message: null,
    };
  }
  if (kind === 'foreign') {
    return {
      state: 'foreign-statusline',
      settingsPath,
      hasData,
      message: 'A custom statusLine command is already configured in Antigravity.',
    };
  }

  return {
    state: 'missing',
    settingsPath,
    hasData,
    message: 'Antigravity quota sensor is not installed.',
  };
}

export async function installAgySensor(
  deps: AgyAdapterDeps = {},
  options?: InstallAgyQuotaSensorOptions,
): Promise<AgySensorInstallResult> {
  const home = deps.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const installFn = deps.installSensorFn ?? installAgyQuotaSensor;

  let outcome: { ok: boolean; action: string; error?: string };
  try {
    outcome = installFn(home, options);
  } catch {
    outcome = {
      ok: false,
      action: 'failed',
      error: 'Failed to install Antigravity quota sensor.',
    };
  }

  const status = await checkAgySensorStatus(deps);

  if (!outcome.ok) {
    return {
      ok: false,
      action: 'failed',
      message: outcome.error ?? 'Failed to install Antigravity quota sensor.',
      status,
    };
  }

  const action = outcome.action as 'installed' | 'chained' | 'noop';
  return {
    ok: true,
    action: action === 'chained' ? 'chained' : action === 'noop' ? 'noop' : 'installed',
    message: null,
    status,
  };
}

export async function readAgyQuota(deps: AgyAdapterDeps = {}): Promise<ProviderQuota> {
  const now = deps.now ?? Date.now;
  const home = deps.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? '';
  const quotaPath = path.join(home, '.wmux', 'quota', 'agy.json');

  const base: Omit<ProviderQuota, 'status' | 'windows' | 'planLabel' | 'capturedAtMs' | 'contextUsage' | 'message'> = {
    provider: 'agy',
    creditsLabel: null,
    fetchedAtMs: now(),
    avgTokensPerMessage: null,
  };

  const sensorStatus = await checkAgySensorStatus(deps);

  let raw: string | null = null;
  try {
    raw = deps.readAgyFile
      ? await deps.readAgyFile(quotaPath)
      : await fs.promises.readFile(quotaPath, 'utf8').catch(() => null);
  } catch {
    raw = null;
  }

  if (!raw) {
    if (sensorStatus.state !== 'installed') {
      return {
        ...base,
        status: 'sensor-missing',
        windows: [],
        planLabel: null,
        capturedAtMs: null,
        contextUsage: null,
        message: 'Antigravity quota sensor is not installed.',
      };
    }
    return {
      ...base,
      status: 'no-data',
      windows: [],
      planLabel: null,
      capturedAtMs: null,
      contextUsage: null,
      message: 'Sensor installed, but no session run yet.',
    };
  }

  let record: StoredAgyRecord;
  try {
    record = JSON.parse(raw) as StoredAgyRecord;
  } catch {
    return {
      ...base,
      status: 'error',
      windows: [],
      planLabel: null,
      capturedAtMs: null,
      contextUsage: null,
      message: 'Invalid Antigravity quota file.',
    };
  }

  const quota = record.quota;
  if (!quota || typeof quota !== 'object' || Object.keys(quota).length === 0) {
    return {
      ...base,
      status: 'no-data',
      windows: [],
      planLabel: record.plan_tier ?? null,
      capturedAtMs: record.quotaCapturedAtMs ?? record.capturedAtMs ?? null,
      contextUsage: record.context_window
        ? {
            inputTokens: record.context_window.total_input_tokens ?? null,
            outputTokens: record.context_window.total_output_tokens ?? null,
          }
        : null,
      message: 'No quota data reported in Antigravity sensor file.',
    };
  }

  const windows: QuotaWindow[] = [];
  for (const [bucketName, bucket] of Object.entries(quota)) {
    const remaining = bucket.remaining_fraction;
    const usedPct =
      typeof remaining === 'number' && Number.isFinite(remaining)
        ? Math.max(0, Math.min(100, Math.round((1 - remaining) * 100)))
        : null;

    let resetAtMs: number | null = null;
    if (typeof bucket.reset_time === 'string') {
      const parsed = Date.parse(bucket.reset_time);
      if (Number.isFinite(parsed) && parsed > 0) resetAtMs = parsed;
    } else if (typeof bucket.reset_in_seconds === 'number' && Number.isFinite(bucket.reset_in_seconds)) {
      // The countdown was relative to when the sensor wrote the file, not to now; anchoring it to now
      // would push the reset later on every read.
      const capturedAt = record.quotaCapturedAtMs ?? record.capturedAtMs;
      if (typeof capturedAt === 'number' && Number.isFinite(capturedAt)) {
        resetAtMs = capturedAt + Math.round(bucket.reset_in_seconds * 1000);
      }
    }

    let windowMins: number | null = null;
    if (bucketName.includes('5h')) {
      windowMins = 300;
    } else if (bucketName.includes('weekly') || bucketName.includes('7d')) {
      windowMins = 10080;
    } else if (bucketName.includes('daily') || bucketName.includes('24h')) {
      windowMins = 1440;
    }

    windows.push({
      id: bucketName,
      label: formatAgyBucketLabel(bucketName),
      usedPct,
      resetAtMs,
      windowMins,
    });
  }

  return {
    ...base,
    status: 'ok',
    windows,
    planLabel: record.plan_tier ?? null,
    capturedAtMs: record.quotaCapturedAtMs ?? record.capturedAtMs ?? null,
    contextUsage: record.context_window
      ? {
          inputTokens: record.context_window.total_input_tokens ?? null,
          outputTokens: record.context_window.total_output_tokens ?? null,
        }
      : null,
    message: null,
  };
}
