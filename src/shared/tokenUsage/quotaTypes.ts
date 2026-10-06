// Provider-neutral quota contract for Settings -> Token usage. Adapters (claude, codex, agy) map their
// own sources into these shapes; the renderer never sees a provider-specific payload.

export type QuotaProviderId = 'claude' | 'codex' | 'agy';

export const QUOTA_PROVIDERS: readonly QuotaProviderId[] = ['claude', 'codex', 'agy'];

export type QuotaStatus =
  | 'ok'
  | 'no-data' // source reachable but nothing reported yet (e.g. agy sensor installed, no session run)
  | 'sensor-missing' // agy only: statusLine sensor not installed
  | 'unauthorized'
  | 'error'
  | 'unavailable'; // adapter not implemented / CLI not installed

export interface QuotaWindow {
  /** Stable key within a provider, e.g. 'five_hour', 'weekly', or an agy bucket name. */
  id: string;
  /** Human label derived from the window length when known ('5h', 'weekly'), else the bucket name. */
  label: string;
  /** 0-100, null when the source did not report it. */
  usedPct: number | null;
  /** Unix epoch ms, null when unknown. */
  resetAtMs: number | null;
  /** Window length in minutes, null when unknown. */
  windowMins: number | null;
}

export interface ProviderContextUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ProviderQuota {
  provider: QuotaProviderId;
  status: QuotaStatus;
  windows: QuotaWindow[];
  /** Plan / tier label when the source reports one. */
  planLabel: string | null;
  /** Credits summary when the source reports one (codex). */
  creditsLabel: string | null;
  /** When the underlying data was captured by its source (agy sensor), epoch ms. Null when not applicable. */
  capturedAtMs: number | null;
  /** When wmux read it, epoch ms. */
  fetchedAtMs: number;
  contextUsage: ProviderContextUsage | null;
  /** Average tokens per message from local transcripts, null when not computed. */
  avgTokensPerMessage: number | null;
  /** Short, user-facing reason when status is not 'ok'. Never contains secrets. */
  message: string | null;
}

/** Change of one window since the previous manual check. */
export interface QuotaWindowDelta {
  windowId: string;
  /** Percentage points used since the previous check; null when it cannot be computed. */
  deltaPct: number | null;
  /** True when resetAtMs moved forward, i.e. the window reset between the two checks. */
  windowReset: boolean;
  previousCheckedAtMs: number;
}

export interface ProviderQuotaReading {
  quota: ProviderQuota;
  deltas: QuotaWindowDelta[];
}

export interface QuotaReadRequest {
  /** Providers to read; omitted means every active provider. */
  providers?: QuotaProviderId[];
}

export interface QuotaReadResult {
  readings: ProviderQuotaReading[];
}

export type AgySensorState = 'installed' | 'missing' | 'foreign-statusline' | 'error';

export interface AgySensorStatus {
  state: AgySensorState;
  settingsPath: string;
  /** True when a quota file exists and is readable. */
  hasData: boolean;
  message: string | null;
}

export interface AgySensorInstallResult {
  ok: boolean;
  action: 'installed' | 'chained' | 'noop' | 'failed';
  message: string | null;
  status: AgySensorStatus;
}
