import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QuotaService } from '../QuotaService';
import { isValidLastCheckEntry, loadLastCheckStore } from '../lastCheckStore';
import type { UsageSnapshot } from '../../claude/UsageApi';
import type { CodexAccountStatus } from '../../../shared/phoneCodexAccountStatus';

describe('QuotaService', () => {
  let tmpHome: string;
  const SECRET_TOKEN = 'sk-ant-api03-super-secret-token-1234567890';

  beforeEach(() => {
    vi.useFakeTimers();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-quota-service-test-'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function setupAgySettings(command?: string) {
    const settingsDir = path.join(tmpHome, '.gemini', 'antigravity-cli');
    fs.mkdirSync(settingsDir, { recursive: true });
    const sinkPath = path.join(tmpHome, '.wmux', 'bin', 'quota-sink.js');
    const settings = {
      statusLine: {
        type: 'command',
        command: command ?? `node ${sinkPath} agy`,
        enabled: true,
        stack_with_default: true,
      },
    };
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify(settings), 'utf8');
  }

  function setupAgyQuota(payload: Record<string, unknown>) {
    const quotaDir = path.join(tmpHome, '.wmux', 'quota');
    fs.mkdirSync(quotaDir, { recursive: true });
    fs.writeFileSync(path.join(quotaDir, 'agy.json'), JSON.stringify(payload), 'utf8');
  }

  it('maps Claude UsageSnapshot into quota reading and windows', async () => {
    const snapshot: UsageSnapshot = {
      sessionPct: 35,
      sessionResetEpochSec: 1760000000,
      weeklyPct: 72,
      weeklyResetEpochSec: 1760600000,
      fetchedAtMs: 1759000000000,
      scoped: [
        {
          kind: 'weekly_scoped',
          group: 'opus',
          pct: 10,
          resetEpochSec: 1760600000,
          scope: 'claude-3-opus',
        },
      ],
    };

    const service = new QuotaService({
      homeDir: tmpHome,
      loadClaudeCred: async () => ({
        ok: true,
        credential: {
          accessToken: SECRET_TOKEN,
          subscriptionType: 'max',
          rateLimitTier: 'tier-4',
          expiresAtMs: 1770000000000,
        },
      }),
      fetchClaude: async () => snapshot,
    });

    const result = await service.readQuota({ providers: ['claude'] });
    expect(result.readings).toHaveLength(1);
    const reading = result.readings[0];
    expect(reading.quota.provider).toBe('claude');
    expect(reading.quota.status).toBe('ok');
    expect(reading.quota.planLabel).toBe('max');
    expect(reading.quota.windows).toEqual([
      {
        id: 'five_hour',
        label: '5h',
        usedPct: 35,
        resetAtMs: 1760000000000,
        windowMins: 300,
      },
      {
        id: 'weekly',
        label: 'weekly',
        usedPct: 72,
        resetAtMs: 1760600000000,
        windowMins: 10080,
      },
      {
        id: 'scoped-claude-3-opus',
        label: 'claude-3-opus (weekly)',
        usedPct: 10,
        resetAtMs: 1760600000000,
        windowMins: 10080,
      },
    ]);

    // Token must never appear in any returned object
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain('super-secret');
  });

  it('maps Codex projected rate limits into quota reading and windows', async () => {
    const codexStatus: CodexAccountStatus = {
      auth: { state: 'signed-in', method: 'chatgpt' },
      rateLimits: {
        ordinaryUsageAllowed: true,
        planType: 'plus',
        buckets: [
          {
            limitId: 'codex',
            limitName: 'Codex',
            primary: { usedPercent: 20, windowMinutes: 300, resetsAt: 1760000000000 },
            secondary: { usedPercent: 45, windowMinutes: 10080, resetsAt: 1760600000000 },
            reachedType: null,
          },
        ],
      },
      fetchedAt: 1759000000000,
      cached: false,
    };

    const service = new QuotaService({
      homeDir: tmpHome,
      readCodex: async () => codexStatus,
    });

    const result = await service.readQuota({ providers: ['codex'] });
    expect(result.readings).toHaveLength(1);
    const reading = result.readings[0];
    expect(reading.quota.provider).toBe('codex');
    expect(reading.quota.status).toBe('ok');
    expect(reading.quota.planLabel).toBe('plus');
    expect(reading.quota.windows).toEqual([
      {
        id: '5h',
        label: '5h',
        usedPct: 20,
        resetAtMs: 1760000000000,
        windowMins: 300,
      },
      {
        id: 'weekly',
        label: 'weekly',
        usedPct: 45,
        resetAtMs: 1760600000000,
        windowMins: 10080,
      },
    ]);
  });

  it('maps Antigravity (agy) sensor record into quota reading and windows', async () => {
    setupAgySettings();
    setupAgyQuota({
      quota: {
        'gemini-5h': {
          remaining_fraction: 0.8,
          reset_time: '2026-10-01T05:00:00.000Z',
        },
        '3p-weekly': {
          remaining_fraction: 0.25,
          reset_in_seconds: 3600,
        },
      },
      quotaCapturedAtMs: 1759000050000,
      plan_tier: 'pro',
      context_window: {
        total_input_tokens: 12000,
        total_output_tokens: 450,
      },
      capturedAtMs: 1759000060000,
    });

    const service = new QuotaService({ homeDir: tmpHome });
    const result = await service.readQuota({ providers: ['agy'] });
    expect(result.readings).toHaveLength(1);
    const reading = result.readings[0];
    expect(reading.quota.provider).toBe('agy');
    expect(reading.quota.status).toBe('ok');
    expect(reading.quota.planLabel).toBe('pro');
    expect(reading.quota.capturedAtMs).toBe(1759000050000);
    expect(reading.quota.contextUsage).toEqual({
      inputTokens: 12000,
      outputTokens: 450,
    });

    const win5h = reading.quota.windows.find((w) => w.id === 'gemini-5h');
    expect(win5h).toBeDefined();
    expect(win5h?.label).toBe('Gemini 5h');
    expect(win5h?.usedPct).toBe(20);
    expect(win5h?.windowMins).toBe(300);
    expect(win5h?.resetAtMs).toBe(Date.parse('2026-10-01T05:00:00.000Z'));

    const win3p = reading.quota.windows.find((w) => w.id === '3p-weekly');
    expect(win3p).toBeDefined();
    expect(win3p?.label).toBe('3p weekly');
    expect(win3p?.usedPct).toBe(75);
    expect(win3p?.windowMins).toBe(10080);
  });

  it('isolates errors: if one adapter throws, the others still succeed', async () => {
    setupAgySettings();
    setupAgyQuota({
      quota: { 'gemini-5h': { remaining_fraction: 0.5 } },
    });

    const service = new QuotaService({
      homeDir: tmpHome,
      loadClaudeCred: async () => {
        throw new Error('Disk failure reading credentials');
      },
      readCodex: async () => {
        return {
          auth: { state: 'signed-in', method: 'chatgpt' },
          rateLimits: {
            ordinaryUsageAllowed: true,
            planType: 'team',
            buckets: [
              {
                limitId: 'codex',
                limitName: null,
                primary: { usedPercent: 10, windowMinutes: 300, resetsAt: 1760000000000 },
                secondary: null,
                reachedType: null,
              },
            ],
          },
          fetchedAt: Date.now(),
          cached: false,
        };
      },
    });

    const result = await service.readQuota();
    expect(result.readings).toHaveLength(3);

    const claude = result.readings.find((r) => r.quota.provider === 'claude');
    expect(claude?.quota.status).toBe('error');
    expect(claude?.quota.message).toBeTruthy();

    const codex = result.readings.find((r) => r.quota.provider === 'codex');
    expect(codex?.quota.status).toBe('ok');
    expect(codex?.quota.windows).toHaveLength(1);

    const agy = result.readings.find((r) => r.quota.provider === 'agy');
    expect(agy?.quota.status).toBe('ok');
    expect(agy?.quota.windows).toHaveLength(1);
  });

  it('calculates delta math including reset detection', async () => {
    let now = 1000000;
    const nowFn = () => now;

    let codexPct = 20;
    let resetAt = 5000000;

    const service = new QuotaService({
      homeDir: tmpHome,
      now: nowFn,
      readCodex: async () => ({
        auth: { state: 'signed-in', method: 'chatgpt' },
        rateLimits: {
          ordinaryUsageAllowed: true,
          planType: 'plus',
          buckets: [
            {
              limitId: 'codex',
              limitName: null,
              primary: { usedPercent: codexPct, windowMinutes: 300, resetsAt: resetAt },
              secondary: null,
              reachedType: null,
            },
          ],
        },
        fetchedAt: now,
        cached: false,
      }),
    });

    // Check 1: No previous check -> deltaPct is null, previousCheckedAtMs: 0
    const first = await service.readQuota({ providers: ['codex'] });
    expect(first.readings[0].deltas).toEqual([
      {
        windowId: '5h',
        deltaPct: null,
        windowReset: false,
        previousCheckedAtMs: 0,
      },
    ]);

    // Check 2: 10 minutes later, usage increased from 20% to 35%
    now += 10 * 60 * 1000;
    codexPct = 35;
    const second = await service.readQuota({ providers: ['codex'] });
    expect(second.readings[0].deltas).toEqual([
      {
        windowId: '5h',
        deltaPct: 15, // 35 - 20
        windowReset: false,
        previousCheckedAtMs: 1000000,
      },
    ]);

    // Check 3: Window reset: resetAtMs moved forward by > 60s
    now += 5 * 60 * 1000;
    resetAt += 5 * 60 * 60 * 1000; // moved 5 hours forward
    codexPct = 5;
    const third = await service.readQuota({ providers: ['codex'] });
    expect(third.readings[0].deltas).toEqual([
      {
        windowId: '5h',
        deltaPct: null, // null when windowReset is true
        windowReset: true,
        previousCheckedAtMs: 1600000,
      },
    ]);
  });

  it('for agy computes delta only when quotaCapturedAtMs changed', async () => {
    let now = 1000000;
    let capturedAt = 1000000;
    let fraction = 0.8; // 20% used

    setupAgySettings();

    const service = new QuotaService({
      homeDir: tmpHome,
      now: () => now,
      readAgyFile: async () =>
        JSON.stringify({
          quota: { 'gemini-5h': { remaining_fraction: fraction, reset_time: '2026-10-01T05:00:00.000Z' } },
          quotaCapturedAtMs: capturedAt,
        }),
    });

    // First check
    const r1 = await service.readQuota({ providers: ['agy'] });
    expect(r1.readings[0].deltas[0].deltaPct).toBeNull();

    // Second check: now changed, but capturedAt did NOT change
    now += 60000;
    fraction = 0.5; // used would be 50%, but sensor hasn't updated capturedAt
    const r2 = await service.readQuota({ providers: ['agy'] });
    expect(r2.readings[0].deltas[0].deltaPct).toBeNull();

    // Third check: capturedAt changed
    now += 60000;
    capturedAt += 60000;
    fraction = 0.5; // 50% used now
    const r3 = await service.readQuota({ providers: ['agy'] });
    expect(r3.readings[0].deltas[0].deltaPct).toBe(30); // 50 - 20
  });

  it('gracefully handles missing or corrupt last-check.json', async () => {
    const quotaDir = path.join(tmpHome, '.wmux', 'quota');
    fs.mkdirSync(quotaDir, { recursive: true });
    fs.writeFileSync(path.join(quotaDir, 'last-check.json'), '{corrupt-json', 'utf8');

    const service = new QuotaService({
      homeDir: tmpHome,
      readCodex: async () => ({
        auth: { state: 'signed-in', method: 'chatgpt' },
        rateLimits: {
          ordinaryUsageAllowed: true,
          planType: 'pro',
          buckets: [
            {
              limitId: 'codex',
              limitName: null,
              primary: { usedPercent: 10, windowMinutes: 300, resetsAt: 1000 },
              secondary: null,
              reachedType: null,
            },
          ],
        },
        fetchedAt: Date.now(),
        cached: false,
      }),
    });

    const res = await service.readQuota({ providers: ['codex'] });
    expect(res.readings[0].deltas[0].deltaPct).toBeNull();
    expect(res.readings[0].deltas[0].previousCheckedAtMs).toBe(0);
  });

  it('atomic write leaves no .tmp files on disk', async () => {
    const service = new QuotaService({
      homeDir: tmpHome,
      readCodex: async () => ({
        auth: { state: 'signed-in', method: 'chatgpt' },
        rateLimits: {
          ordinaryUsageAllowed: true,
          planType: 'pro',
          buckets: [
            {
              limitId: 'codex',
              limitName: null,
              primary: { usedPercent: 10, windowMinutes: 300, resetsAt: 1000 },
              secondary: null,
              reachedType: null,
            },
          ],
        },
        fetchedAt: Date.now(),
        cached: false,
      }),
    });

    await service.readQuota({ providers: ['codex'] });

    const quotaDir = path.join(tmpHome, '.wmux', 'quota');
    expect(fs.existsSync(path.join(quotaDir, 'last-check.json'))).toBe(true);

    const files = fs.readdirSync(quotaDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('agy returns sensor-missing when not installed and no data, no-data when installed but no data', async () => {
    const service = new QuotaService({ homeDir: tmpHome });

    // Missing settings / sensor
    const r1 = await service.readQuota({ providers: ['agy'] });
    expect(r1.readings[0].quota.status).toBe('sensor-missing');
    expect(r1.readings[0].quota.message).toContain('not installed');

    // Installed sensor, but no agy.json file
    setupAgySettings();
    const r2 = await service.readQuota({ providers: ['agy'] });
    expect(r2.readings[0].quota.status).toBe('no-data');
    expect(r2.readings[0].quota.message).toContain('Sensor installed, but no session run yet');

    // Installed sensor, agy.json exists but quota is empty
    setupAgyQuota({ quota: {} });
    const r3 = await service.readQuota({ providers: ['agy'] });
    expect(r3.readings[0].quota.status).toBe('no-data');
  });

  it('no timers or background polling scheduled', async () => {
    // Stub the credential and codex readers: the defaults read the real
    // ~/.claude login and would start a network request (and its timeout
    // timer) on a machine that is signed in.
    const service = new QuotaService({
      homeDir: tmpHome,
      loadClaudeCred: async () => ({ ok: false, reason: 'not-found' }),
      readCodex: async () => { throw new Error('codex not installed'); },
    });
    await service.readQuota();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('lastCheckStore malformed entry validation & error isolation', () => {
    it('isValidLastCheckEntry strictly validates fields (null, string, missing, negative/NaN)', () => {
      // null entry
      expect(isValidLastCheckEntry(null)).toBe(false);
      expect(isValidLastCheckEntry(undefined)).toBe(false);

      // string entry
      expect(isValidLastCheckEntry('string-entry')).toBe(false);
      expect(
        isValidLastCheckEntry({
          usedPct: '50',
          resetAtMs: null,
          checkedAtMs: 1000,
        }),
      ).toBe(false);
      expect(
        isValidLastCheckEntry({
          usedPct: 50,
          resetAtMs: 'tomorrow',
          checkedAtMs: 1000,
        }),
      ).toBe(false);
      expect(
        isValidLastCheckEntry({
          usedPct: 50,
          resetAtMs: null,
          checkedAtMs: '1000',
        }),
      ).toBe(false);
      expect(
        isValidLastCheckEntry({
          usedPct: 50,
          resetAtMs: null,
          checkedAtMs: 1000,
          quotaCapturedAtMs: 'not-a-number',
        }),
      ).toBe(false);

      // missing fields
      expect(isValidLastCheckEntry({})).toBe(false);
      expect(isValidLastCheckEntry({ usedPct: 50 })).toBe(false);
      expect(isValidLastCheckEntry({ checkedAtMs: 1000 })).toBe(false);
      expect(isValidLastCheckEntry({ usedPct: 50, checkedAtMs: 1000 })).toBe(false);
      expect(isValidLastCheckEntry({ resetAtMs: null, checkedAtMs: 1000 })).toBe(false);

      // negative numbers
      expect(isValidLastCheckEntry({ usedPct: -1, resetAtMs: null, checkedAtMs: 1000 })).toBe(false);
      expect(isValidLastCheckEntry({ usedPct: 50, resetAtMs: -100, checkedAtMs: 1000 })).toBe(false);
      expect(isValidLastCheckEntry({ usedPct: 50, resetAtMs: null, checkedAtMs: -5 })).toBe(false);
      expect(
        isValidLastCheckEntry({
          usedPct: 50,
          resetAtMs: null,
          checkedAtMs: 1000,
          quotaCapturedAtMs: -500,
        }),
      ).toBe(false);

      // NaN / Infinity numbers
      expect(isValidLastCheckEntry({ usedPct: NaN, resetAtMs: null, checkedAtMs: 1000 })).toBe(false);
      expect(isValidLastCheckEntry({ usedPct: Infinity, resetAtMs: null, checkedAtMs: 1000 })).toBe(false);
      expect(isValidLastCheckEntry({ usedPct: 50, resetAtMs: NaN, checkedAtMs: 1000 })).toBe(false);
      expect(isValidLastCheckEntry({ usedPct: 50, resetAtMs: null, checkedAtMs: NaN })).toBe(false);
      expect(
        isValidLastCheckEntry({
          usedPct: 50,
          resetAtMs: null,
          checkedAtMs: 1000,
          quotaCapturedAtMs: NaN,
        }),
      ).toBe(false);

      // valid entries
      expect(isValidLastCheckEntry({ usedPct: 0, resetAtMs: 0, checkedAtMs: 0 })).toBe(true);
      expect(isValidLastCheckEntry({ usedPct: null, resetAtMs: null, checkedAtMs: 1000 })).toBe(true);
      expect(
        isValidLastCheckEntry({
          usedPct: 45,
          resetAtMs: 1760000000000,
          checkedAtMs: 1759000000000,
          quotaCapturedAtMs: 1759000000000,
        }),
      ).toBe(true);
    });

    it('loadLastCheckStore drops invalid entries individually while keeping valid ones', async () => {
      const quotaDir = path.join(tmpHome, '.wmux', 'quota');
      fs.mkdirSync(quotaDir, { recursive: true });

      const malformedData = {
        'claude:weekly': null,
        'claude:five_hour': 'not-an-object',
        'codex:5h': { usedPct: 20 }, // missing checkedAtMs & resetAtMs
        'codex:weekly': { usedPct: -5, resetAtMs: null, checkedAtMs: 1000 }, // negative usedPct
        'agy:3p-weekly': { usedPct: 30, resetAtMs: null, checkedAtMs: 1000, quotaCapturedAtMs: -1 }, // negative capture
        'agy:gemini-5h': {
          usedPct: 15,
          resetAtMs: 1760000000000,
          checkedAtMs: 1759000000000,
          quotaCapturedAtMs: 1759000000000,
          extraJunkField: 'should be stripped',
        },
      };

      fs.writeFileSync(path.join(quotaDir, 'last-check.json'), JSON.stringify(malformedData), 'utf8');

      const loaded = await loadLastCheckStore(quotaDir);
      expect(loaded).toEqual({
        'agy:gemini-5h': {
          usedPct: 15,
          resetAtMs: 1760000000000,
          checkedAtMs: 1759000000000,
          quotaCapturedAtMs: 1759000000000,
        },
      });
      // The invalid keys were dropped individually
      expect(loaded['claude:weekly']).toBeUndefined();
      expect(loaded['claude:five_hour']).toBeUndefined();
      expect(loaded['codex:5h']).toBeUndefined();
      expect(loaded['codex:weekly']).toBeUndefined();
      expect(loaded['agy:3p-weekly']).toBeUndefined();
      // Extra junk was stripped
      expect((loaded['agy:gemini-5h'] as unknown as Record<string, unknown>).extraJunkField).toBeUndefined();
    });

    it('readQuota never breaks on parseable but malformed last-check.json', async () => {
      const quotaDir = path.join(tmpHome, '.wmux', 'quota');
      fs.mkdirSync(quotaDir, { recursive: true });
      setupAgySettings();
      setupAgyQuota({
        quota: {
          'gemini-5h': { remaining_fraction: 0.7 }, // 30% used
        },
        quotaCapturedAtMs: 1759000060000, // changed from 1759000000000
      });

      const malformedData = {
        'claude:weekly': null,
        'claude:five_hour': 'not-an-object',
        'codex:5h': { usedPct: 20 }, // missing fields
        'codex:weekly': { usedPct: -5, resetAtMs: null, checkedAtMs: 1000 },
        'agy:gemini-5h': {
          usedPct: 15,
          resetAtMs: null,
          checkedAtMs: 1759000000000,
          quotaCapturedAtMs: 1759000000000,
        },
      };
      fs.writeFileSync(path.join(quotaDir, 'last-check.json'), JSON.stringify(malformedData), 'utf8');

      const service = new QuotaService({
        homeDir: tmpHome,
        readCodex: async () => ({
          auth: { state: 'signed-in', method: 'chatgpt' },
          rateLimits: {
            ordinaryUsageAllowed: true,
            planType: 'plus',
            buckets: [
              {
                limitId: 'codex',
                limitName: null,
                primary: { usedPercent: 40, windowMinutes: 300, resetsAt: 1000 },
                secondary: { usedPercent: 60, windowMinutes: 10080, resetsAt: 2000 },
                reachedType: null,
              },
            ],
          },
          fetchedAt: 1759000050000,
          cached: false,
        }),
      });

      // Reading quota must succeed without throwing
      const result = await service.readQuota({ providers: ['codex', 'agy'] });
      expect(result.readings).toHaveLength(2);

      const codexReading = result.readings.find((r) => r.quota.provider === 'codex');
      expect(codexReading).toBeDefined();
      expect(codexReading?.quota.status).toBe('ok');
      // Codex had malformed previous entries -> degrades to no-delta
      expect(codexReading?.deltas[0].deltaPct).toBeNull();
      expect(codexReading?.deltas[0].previousCheckedAtMs).toBe(0);
      expect(codexReading?.deltas[1].deltaPct).toBeNull();
      expect(codexReading?.deltas[1].previousCheckedAtMs).toBe(0);

      const agyReading = result.readings.find((r) => r.quota.provider === 'agy');
      expect(agyReading).toBeDefined();
      expect(agyReading?.quota.status).toBe('ok');
      // agy had a valid previous entry (15%) -> computed delta 30 - 15 = 15%
      expect(agyReading?.deltas[0].deltaPct).toBe(15);
      expect(agyReading?.deltas[0].previousCheckedAtMs).toBe(1759000000000);
    });

    it('wraps delta computation per provider so an exception degrades that provider to no-delta without failing others', async () => {
      const quotaDir = path.join(tmpHome, '.wmux', 'quota');
      fs.mkdirSync(quotaDir, { recursive: true });
      setupAgySettings();
      setupAgyQuota({
        quota: {
          'gemini-5h': { remaining_fraction: 0.6 }, // 40% used
        },
        quotaCapturedAtMs: 2000,
      });

      // Write valid previous check entries for codex and agy
      const validStore = {
        'codex:5h': { usedPct: 20, resetAtMs: null, checkedAtMs: 1000 },
        'agy:gemini-5h': { usedPct: 10, resetAtMs: null, checkedAtMs: 1000, quotaCapturedAtMs: 1000 },
      };
      fs.writeFileSync(path.join(quotaDir, 'last-check.json'), JSON.stringify(validStore), 'utf8');

      // Create a value for codex whose valueOf() throws during subtraction in deltaPct computation
      const explodingValue = {
        valueOf() {
          throw new Error('Explosion during codex delta calculation');
        },
      };

      const service = new QuotaService({
        homeDir: tmpHome,
        now: () => 2000,
        readCodex: async () => ({
          auth: { state: 'signed-in', method: 'chatgpt' },
          rateLimits: {
            ordinaryUsageAllowed: true,
            planType: 'plus',
            buckets: [
              {
                limitId: 'codex',
                limitName: null,
                primary: { usedPercent: explodingValue as unknown as number, windowMinutes: 300, resetsAt: 1000 },
                secondary: null,
                reachedType: null,
              },
            ],
          },
          fetchedAt: 2000,
          cached: false,
        }),
      });

      const result = await service.readQuota({ providers: ['codex', 'agy'] });
      expect(result.readings).toHaveLength(2);

      // Codex threw during delta computation -> degraded to no-delta
      const codexReading = result.readings.find((r) => r.quota.provider === 'codex');
      expect(codexReading).toBeDefined();
      expect(codexReading?.quota.status).toBe('ok');
      expect(codexReading?.deltas).toHaveLength(1);
      expect(codexReading?.deltas[0].deltaPct).toBeNull();
      expect(codexReading?.deltas[0].windowReset).toBe(false);
      expect(codexReading?.deltas[0].previousCheckedAtMs).toBe(0);

      // Antigravity still succeeded with valid delta computation
      const agyReading = result.readings.find((r) => r.quota.provider === 'agy');
      expect(agyReading).toBeDefined();
      expect(agyReading?.quota.status).toBe('ok');
      expect(agyReading?.deltas[0].deltaPct).toBe(30); // 40 - 10
      expect(agyReading?.deltas[0].previousCheckedAtMs).toBe(1000);
    });

    it('fills avgTokensPerMessage for Claude and Codex using injected directories, agy stays null', async () => {
      // Setup Claude transcript in tmpHome/.claude/projects/myproj/s1.jsonl
      const claudeProjDir = path.join(tmpHome, '.claude', 'projects', 'myproj');
      fs.mkdirSync(claudeProjDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeProjDir, 's1.jsonl'),
        JSON.stringify({
          type: 'assistant',
          message: { id: 'm1', usage: { input_tokens: 120, output_tokens: 80 } },
        }) + '\n',
        'utf8',
      );

      // Setup Codex transcript in tmpHome/.codex/sessions/s1.jsonl
      const codexSessDir = path.join(tmpHome, '.codex', 'sessions');
      fs.mkdirSync(codexSessDir, { recursive: true });
      fs.writeFileSync(
        path.join(codexSessDir, 's1.jsonl'),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 300, output_tokens: 100 },
              total_token_usage: { total_tokens: 400 },
            },
          },
        }) + '\n',
        'utf8',
      );

      // Setup Agy quota file
      setupAgySettings();
      setupAgyQuota({
        version: 1,
        buckets: [{ name: 'standard', remaining_fraction: 0.8, resets_at: 1760000000000 }],
        last_updated: 1759000000000,
      });

      const service = new QuotaService({
        homeDir: tmpHome,
        loadClaudeCred: async () => ({
          ok: true,
          credential: {
            accessToken: SECRET_TOKEN,
            subscriptionType: 'pro',
            rateLimitTier: 'tier-1',
            expiresAtMs: 1770000000000,
          },
        }),
        fetchClaude: async () => ({
          sessionPct: 10,
          sessionResetEpochSec: 1760000000,
          weeklyPct: 20,
          weeklyResetEpochSec: 1760600000,
          fetchedAtMs: 1759000000000,
        }),
        readCodex: async () => ({
          auth: { state: 'signed-in', method: 'chatgpt' },
          rateLimits: {
            ordinaryUsageAllowed: true,
            planType: 'plus',
            buckets: [
              {
                limitId: 'codex',
                limitName: null,
                primary: { usedPercent: 15, resetsAt: 1760000000000, windowMinutes: 300 },
                secondary: null,
                reachedType: null,
              },
            ],
          },
          fetchedAt: 1759000000000,
          cached: false,
        }),
      });

      const res = await service.readQuota({ providers: ['claude', 'codex', 'agy'] });

      const claude = res.readings.find((r) => r.quota.provider === 'claude');
      expect(claude?.quota.avgTokensPerMessage).toBe(200); // 120 + 80

      const codex = res.readings.find((r) => r.quota.provider === 'codex');
      expect(codex?.quota.avgTokensPerMessage).toBe(400); // 300 + 100

      const agy = res.readings.find((r) => r.quota.provider === 'agy');
      expect(agy?.quota.avgTokensPerMessage).toBeNull();
    });

    it('scan failure yields null and never fails the provider reading', async () => {
      const service = new QuotaService({
        homeDir: tmpHome,
        scanClaudeTranscripts: async () => {
          throw new Error('Disk read error');
        },
        loadClaudeCred: async () => ({
          ok: true,
          credential: {
            accessToken: SECRET_TOKEN,
            subscriptionType: 'pro',
            rateLimitTier: 'tier-1',
            expiresAtMs: 1770000000000,
          },
        }),
        fetchClaude: async () => ({
          sessionPct: 10,
          sessionResetEpochSec: 1760000000,
          weeklyPct: 20,
          weeklyResetEpochSec: 1760600000,
          fetchedAtMs: 1759000000000,
        }),
      });

      const res = await service.readQuota({ providers: ['claude'] });
      expect(res.readings).toHaveLength(1);
      const claude = res.readings[0];
      expect(claude.quota.status).toBe('ok');
      expect(claude.quota.avgTokensPerMessage).toBeNull();
    });
  });
});

