/*
 * Live integration gate for issue #810.
 *
 * Run after `npm run package`. The harness boots the packaged app in a fresh,
 * suffixed profile; drives the real named-pipe router, renderer bridge, CDP,
 * and packaged CLI; then removes only its own temporary profile.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const APP_EXE = path.join(REPO_ROOT, 'out', 'wmux-win32-x64', 'wmux.exe');
const CLI_BUNDLE = path.join(
  REPO_ROOT,
  'out',
  'wmux-win32-x64',
  'resources',
  'cli-bundle',
  'index.js',
);
const APP_URL_PREFIX = pathToFileURL(path.join(REPO_ROOT, 'out', 'wmux-win32-x64')).href.toLowerCase();
const USERNAME = os.userInfo().username || 'default';
const APPROVED_PLUGIN = 'issue-810-approved-plugin';
const FIRST_PARTY = 'claude-code';

const results = [];
let app = null;
let browser = null;
let localServer = null;
let token = null;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(ok);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== 'win32') {
  console.log('issue-810-dogfood: SKIP (win32-only)');
  process.exit(0);
}
for (const required of [APP_EXE, CLI_BUNDLE]) {
  if (!fs.existsSync(required)) {
    console.error(`packaged artifact not found: ${required} — run \`npm run package\` first`);
    process.exit(2);
  }
}

const suffix = `-issue810dog${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-810dog-'));
const wmuxDir = path.join(home, `.wmux${suffix}`);
const userDataDir = path.join(home, 'AppData', 'Roaming', `wmux${suffix}`);
const mainPipe = `\\\\.\\pipe\\wmux${suffix}-${USERNAME}`;
const authTokenPath = path.join(home, `.wmux${suffix}-auth-token`);
const auditPath = path.join(wmuxDir, 'shadow-rejections.log');
const pidMapDir = path.join(wmuxDir, 'pid-map');
const anchorPath = path.join(pidMapDir, String(process.pid));
const env = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  WMUX_DATA_SUFFIX: suffix,
  WMUX_NO_DIALOG: '1',
  WMUX_DISCARD_AFTER_MS: '1200',
  // Packaged assets still load from disk. This opens app DevTools so the live
  // target catalog contains both the shell and a DevTools target.
  NODE_ENV: 'development',
};
delete env.HOMEDRIVE;
delete env.HOMEPATH;
delete env.WMUX_DISABLE_CDP;

fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(wmuxDir, { recursive: true });
fs.writeFileSync(path.join(userDataDir, '.first-run'), new Date().toISOString(), 'utf8');
const now = Date.now();
fs.writeFileSync(
  path.join(wmuxDir, 'plugin-trust.json'),
  JSON.stringify({
    schemaVersion: 1,
    plugins: {
      [APPROVED_PLUGIN]: {
        name: APPROVED_PLUGIN,
        status: 'trusted',
        firstSeen: now,
        lastSeen: now,
        declaredCapabilities: ['browser.read'],
      },
    },
  }, null, 2),
  'utf8',
);

function readToken() {
  try {
    return fs.readFileSync(authTokenPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function rpcCall(method, params = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(mainPipe);
    const id = randomUUID();
    let buffer = '';
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* best effort */ }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`RPC timeout: ${method}`))),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(JSON.stringify({
        id,
        method,
        params,
        token,
        ...(options.clientName ? { clientName: options.clientName, clientVersion: '810-dogfood' } : {}),
      }) + '\n');
    });
    socket.once('error', (error) => finish(() => reject(error)));
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== id) continue;
        finish(() => resolve(message));
        return;
      }
    });
  });
}

async function rpcResult(method, params = {}, options = {}) {
  const response = await rpcCall(method, params, options);
  if (!response?.ok) {
    throw new Error(`${method}: ${response?.error ?? JSON.stringify(response)}`);
  }
  return response.result;
}

async function tabs(action, workspaceId, extra = {}) {
  return rpcResult('browser.tabs', { action, workspaceId, ...extra });
}

async function waitUntil(probe, timeoutMs, label, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out (${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

async function waitForToken(timeoutMs = 20_000) {
  return waitUntil(() => readToken(), timeoutMs, 'main auth token');
}

async function waitForRenderer(timeoutMs = 35_000) {
  return waitUntil(async () => {
    const response = await rpcCall('workspace.list', {}, { timeoutMs: 4_000 });
    return response?.ok && Array.isArray(response.result) && response.result.length > 0
      ? response.result
      : null;
  }, timeoutMs, 'renderer readiness', 250);
}

async function cdpInfo(clientName, workspaceId) {
  return rpcResult(
    'browser.cdp.info',
    workspaceId ? { workspaceId } : {},
    clientName ? { clientName } : {},
  );
}

async function waitForTargets(clientName, workspaceId, expected, timeoutMs = 25_000) {
  return waitUntil(async () => {
    const info = await cdpInfo(clientName, workspaceId);
    return info.targets?.length === expected ? info : null;
  }, timeoutMs, `${workspaceId} target count ${expected}`, 250);
}

async function pageUrl(workspaceId, surfaceId) {
  const result = await rpcResult('browser.evaluate', {
    workspaceId,
    surfaceId,
    expression: 'location.href',
  });
  return result?.value;
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const label = (request.url || '/').replace(/[^a-zA-Z0-9_-]/g, '_');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>${label}</title><main data-route="${label}">${label}</main>`);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://localhost:${address.port}` });
    });
  });
}

function spawnApp() {
  const proc = spawn(APP_EXE, [], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: false,
  });
  proc.stdout.resume();
  proc.stderr.resume();
  return proc;
}

async function findShellPage(shellUrl, timeoutMs = 25_000) {
  return waitUntil(async () => {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        try {
          const urlMatches = shellUrl ? page.url() === shellUrl : page.url().toLowerCase().startsWith(APP_URL_PREFIX);
          if (!urlMatches) continue;
          if (await page.evaluate(() => Boolean(window.electronAPI?.rpc?.invoke))) return page;
        } catch { /* page navigating */ }
      }
    }
    return null;
  }, timeoutMs, 'wmux shell page', 100);
}

async function rawCdpCatalog(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP catalog HTTP ${response.status}`);
  return response.json();
}

function readAudit() {
  try {
    return fs.readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

function runCli(args, cliEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BUNDLE, ...args], {
      cwd: REPO_ROOT,
      env: cliEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      reject(new Error(`CLI timeout: ${args.join(' ')}\n${stderr}`));
    }, 25_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  console.log(`issue-810-dogfood\n  exe=${APP_EXE}\n  home=${home}\n  suffix=${suffix}`);
  const local = await startLocalServer();
  localServer = local.server;
  const base = local.baseUrl;

  app = spawnApp();
  token = await waitForToken();
  const workspaces = await waitForRenderer();
  const workspaceA = workspaces[0].id;
  check('isolated packaged renderer is ready', Boolean(workspaceA), `A=${workspaceA}`);

  const terminalA = await waitUntil(async () => {
    const surfaces = await rpcResult('surface.list', { workspaceId: workspaceA });
    return surfaces.find((surface) => surface.surfaceType !== 'browser' && surface.ptyId) ?? null;
  }, 25_000, 'workspace A terminal PTY', 250);

  // First-party external-wire disclosure also gives this harness the live CDP
  // port. It is deliberately unscoped: PR3 must log the future refusal while
  // PR1 and current behavior still return the same usable response.
  const firstPartyUnscoped = await cdpInfo(FIRST_PARTY);
  check(
    'first-party external wire receives cdpPort + shellUrl',
    Number.isInteger(firstPartyUnscoped.cdpPort) && typeof firstPartyUnscoped.shellUrl === 'string',
    `port=${firstPartyUnscoped.cdpPort} shell=${firstPartyUnscoped.shellUrl}`,
  );
  if (!Number.isInteger(firstPartyUnscoped.cdpPort)) throw new Error('no CDP port from first-party lane');
  if (firstPartyUnscoped.cdpPort < 18800 || firstPartyUnscoped.cdpPort > 18899) {
    throw new Error(`refusing unexpected CDP port ${firstPartyUnscoped.cdpPort}`);
  }

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${firstPartyUnscoped.cdpPort}`);
  const shellPage = await findShellPage(firstPartyUnscoped.shellUrl);
  const operatorEnvelope = await shellPage.evaluate(() =>
    window.electronAPI.rpc.invoke('browser.cdp.info', {}),
  );
  const operatorInfo = operatorEnvelope?.result;
  check(
    'renderer operator lane receives the same attach primitive',
    operatorEnvelope?.ok === true
      && operatorInfo?.cdpPort === firstPartyUnscoped.cdpPort
      && operatorInfo?.shellUrl === firstPartyUnscoped.shellUrl,
  );

  const initialAudit = await waitUntil(() => {
    const entries = readAudit().filter((entry) =>
      entry.entryKind === 'browser-scope'
      && entry.clientName === FIRST_PARTY
      && entry.method === 'browser.cdp.info'
      && entry.reason === 'workspace-unresolved');
    return entries.length > 0 ? entries : null;
  }, 5_000, 'first-party unscoped browser-scope audit');
  check(
    'PR3 logs identified unscoped call without changing its response',
    initialAudit.length >= 1 && Number.isInteger(firstPartyUnscoped.cdpPort),
    `entries=${initialAudit.length}`,
  );

  const workspaceB = (await rpcResult('workspace.new', { name: 'issue-810-B' })).id;
  await rpcResult('workspace.focus', { id: workspaceA });
  check('workspace A restored as visible', (await rpcResult('workspace.current')).id === workspaceA);

  // B is intentionally registered first. That makes a pre-PR2 unscoped CLI
  // navigate deterministically hit B and gives the regression test teeth.
  const newB = await tabs('new', workspaceB, { url: `${base}/b` });
  if (!newB.ok) throw new Error(`create B browser failed: ${JSON.stringify(newB)}`);
  check(
    'background browser new does not yank the visible workspace',
    (await rpcResult('workspace.current')).id === workspaceA,
  );
  const newA1 = await tabs('new', workspaceA, { url: `${base}/a1` });
  const newA2 = await tabs('new', workspaceA, { url: `${base}/a2` });
  if (!newA1.ok || !newA2.ok) throw new Error('create A browsers failed');
  const bId = newB.tab.surfaceId;
  const a1Id = newA1.tab.surfaceId;
  const a2Id = newA2.tab.surfaceId;

  const infoA = await waitForTargets(APPROVED_PLUGIN, workspaceA, 2);
  const infoB = await waitForTargets(APPROVED_PLUGIN, workspaceB, 1);
  check('workspace-scoped target metadata is exactly A=2 / B=1', infoA.targets.length === 2 && infoB.targets.length === 1);

  const scopedFirstParty = await cdpInfo(FIRST_PARTY, workspaceA);
  check(
    'scoped first-party response retains attach info and only A targets',
    scopedFirstParty.cdpPort === firstPartyUnscoped.cdpPort
      && scopedFirstParty.targetsScoped === true
      && scopedFirstParty.targets.length === 2
      && scopedFirstParty.targets.every((target) => target.workspaceId === workspaceA),
  );
  const approvedThirdParty = await cdpInfo(APPROVED_PLUGIN, workspaceA);
  check(
    'approved third-party gets metadata but no attach primitive',
    !('cdpPort' in approvedThirdParty)
      && !('shellUrl' in approvedThirdParty)
      && approvedThirdParty.targets.length === 2,
  );
  const legacyInfo = await cdpInfo(undefined);
  check(
    'legacy caller keeps target compatibility but no attach primitive',
    !('cdpPort' in legacyInfo)
      && !('shellUrl' in legacyInfo)
      && legacyInfo.targets.length === 3,
  );
  check(
    'B is the first global target (pre-PR2 CLI would hit it)',
    legacyInfo.targets[0]?.surfaceId === bId,
    `first=${legacyInfo.targets[0]?.surfaceId} B=${bId}`,
  );

  const catalog = await waitUntil(async () => {
    const entries = await rawCdpCatalog(firstPartyUnscoped.cdpPort);
    return entries.some((entry) => String(entry.url).startsWith('devtools://')) ? entries : null;
  }, 8_000, 'app DevTools target');
  check(
    'global CDP catalog contains shell + DevTools + three guests',
    catalog.length >= 5
      && catalog.some((entry) => entry.url === firstPartyUnscoped.shellUrl)
      && catalog.some((entry) => String(entry.url).startsWith('devtools://')),
    `targets=${catalog.length}`,
  );
  check('browser.cdp.info excludes shell and DevTools', legacyInfo.targets.length === 3);

  const listA = await tabs('list', workspaceA);
  const listB = await tabs('list', workspaceB);
  check(
    'logical tab lists are workspace-exact and IDs are distinct',
    listA.ok
      && listB.ok
      && listA.tabs.length === 2
      && listB.tabs.length === 1
      && new Set(listA.tabs.map((tab) => tab.surfaceId)).size === 2
      && listB.tabs[0].surfaceId === bId,
  );
  const browserSurfacesB = (await rpcResult('surface.list', { workspaceId: workspaceB }))
    .filter((surface) => surface.surfaceType === 'browser');
  check(
    'background new produced one non-stranded B browser surface',
    browserSurfacesB.length === 1 && browserSurfacesB[0].id === bId,
  );

  fs.mkdirSync(pidMapDir, { recursive: true });
  fs.writeFileSync(anchorPath, terminalA.ptyId, 'utf8');
  const bUrlBeforeCli = await pageUrl(workspaceB, bId);
  const cli = await runCli(
    ['browser', 'navigate', `${base}/cli`, '--json'],
    {
      ...env,
      WMUX_SOCKET_PATH: mainPipe,
      WMUX_AUTH_TOKEN: token,
      WMUX_WORKSPACE_ID: workspaceA,
      WMUX_PTY_ID: terminalA.ptyId,
    },
  );
  check('packaged CLI navigate exits successfully', cli.code === 0, cli.stderr.trim() || cli.stdout.trim());
  const cliRouted = await waitUntil(async () => {
    const [a1, a2, b] = await Promise.all([
      pageUrl(workspaceA, a1Id),
      pageUrl(workspaceA, a2Id),
      pageUrl(workspaceB, bId),
    ]);
    return (a1 === `${base}/cli` || a2 === `${base}/cli`) && b === bUrlBeforeCli
      ? { a1, a2, b }
      : null;
  }, 12_000, 'CLI caller-workspace navigation', 200);
  check(
    'PR2 CLI ancestry scopes navigation to A and leaves first-global B unchanged',
    cliRouted.b === bUrlBeforeCli,
    JSON.stringify(cliRouted),
  );

  const foreignSelect = await tabs('select', workspaceA, { surfaceId: bId });
  const foreignClose = await tabs('close', workspaceA, { surfaceId: bId });
  const randomClose = await tabs('close', workspaceA, { surfaceId: `missing-${randomUUID()}` });
  const bAfterForeign = await tabs('list', workspaceB);
  check(
    'foreign select/close match random not-found and leave B unchanged',
    foreignSelect.ok === false
      && foreignClose.ok === false
      && randomClose.ok === false
      && foreignSelect.error.code === 'BROWSER_TAB_NOT_FOUND'
      && foreignClose.error.code === randomClose.error.code
      && foreignClose.error.message === randomClose.error.message
      && bAfterForeign.ok
      && bAfterForeign.tabs.length === 1
      && bAfterForeign.tabs[0].surfaceId === bId,
  );

  const beforeDiscardTargetIds = new Set(infoA.targets.map((target) => target.targetId));
  await shellPage.evaluate(async () => {
    await window.electronAPI.browser.setLightweight(true);
    await window.electronAPI.browser.setDiscard(true);
  });
  await rpcResult('workspace.focus', { id: workspaceB });
  const discardedA = await waitForTargets(APPROVED_PLUGIN, workspaceA, 0, 30_000);
  const liveB = await waitForTargets(APPROVED_PLUGIN, workspaceB, 1);
  const logicalWhileDiscarded = await tabs('list', workspaceA);
  check(
    'discard removes A live targets but preserves both logical tabs',
    discardedA.targets.length === 0
      && liveB.targets.length === 1
      && logicalWhileDiscarded.ok
      && logicalWhileDiscarded.tabs.length === 2,
  );

  await rpcResult('workspace.focus', { id: workspaceA });
  const remountedA = await waitForTargets(APPROVED_PLUGIN, workspaceA, 2, 30_000);
  check(
    'reveal remounts A under stable surface IDs with fresh targets',
    new Set(remountedA.targets.map((target) => target.surfaceId)).size === 2
      && remountedA.targets.every((target) => [a1Id, a2Id].includes(target.surfaceId))
      && remountedA.targets.some((target) => !beforeDiscardTargetIds.has(target.targetId)),
  );

  const selectedA2 = await tabs('select', workspaceA, { surfaceId: a2Id });
  check(
    'owned select is stable-ID exact and does not change visible workspace',
    selectedA2.ok
      && selectedA2.tab.surfaceId === a2Id
      && (await rpcResult('workspace.current')).id === workspaceA,
  );
  await rpcResult('browser.navigate', {
    workspaceId: workspaceA,
    surfaceId: a2Id,
    url: `${base}/reload`,
  });
  check('owned A2 remains addressable after target reload', await pageUrl(workspaceA, a2Id) === `${base}/reload`);

  const closeA1 = await tabs('close', workspaceA, { surfaceId: a1Id });
  const afterCloseA1 = await tabs('list', workspaceA);
  const closeA2 = await tabs('close', workspaceA, { surfaceId: a2Id });
  const afterCloseA2 = await tabs('list', workspaceA);
  const finalB = await tabs('list', workspaceB);
  check(
    'owned closes remove only the intended stable IDs; B survives',
    closeA1.ok
      && closeA1.closed.surfaceId === a1Id
      && afterCloseA1.ok
      && afterCloseA1.tabs.length === 1
      && afterCloseA1.tabs[0].surfaceId === a2Id
      && closeA2.ok
      && closeA2.closed.surfaceId === a2Id
      && afterCloseA2.ok
      && afterCloseA2.tabs.length === 0
      && finalB.ok
      && finalB.tabs.length === 1
      && finalB.tabs[0].surfaceId === bId,
  );

  const browserScopeEntries = readAudit().filter((entry) => entry.entryKind === 'browser-scope');
  const cliScopeRejections = browserScopeEntries.filter((entry) =>
    entry.clientName === 'wmux-cli' && entry.method === 'browser.navigate');
  const approvedScopeRejections = browserScopeEntries.filter((entry) =>
    entry.clientName === APPROVED_PLUGIN);
  check(
    'scoped CLI and approved-plugin calls add no callerScope rejection',
    cliScopeRejections.length === 0 && approvedScopeRejections.length === 0,
    `cli=${cliScopeRejections.length} approved=${approvedScopeRejections.length}`,
  );
}

main()
  .catch((error) => {
    console.error('FATAL', error);
    check('harness completed without fatal error', false, error.message);
  })
  .finally(async () => {
    try { fs.unlinkSync(anchorPath); } catch { /* best effort */ }
    try { if (browser) await browser.close(); } catch { /* best effort */ }
    try { if (token) await rpcResult('daemon.shutdown', {}).catch(() => undefined); } catch { /* best effort */ }
    try {
      if (app?.pid) {
        spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      }
    } catch { /* best effort */ }
    try {
      if (localServer) await new Promise((resolve) => localServer.close(resolve));
    } catch { /* best effort */ }
    await sleep(500);
    const resolvedHome = path.resolve(home);
    const resolvedTemp = path.resolve(os.tmpdir());
    if (
      resolvedHome.startsWith(`${resolvedTemp}${path.sep}`)
      && path.basename(resolvedHome).startsWith('wmux-810dog-')
    ) {
      try { fs.rmSync(resolvedHome, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      console.error(`refusing to remove unexpected temp path: ${resolvedHome}`);
    }
    const passed = results.filter((result) => result.ok).length;
    console.log(`\nissue-810-dogfood: ${passed}/${results.length} passed`);
    process.exit(passed === results.length && results.length > 0 ? 0 : 1);
  });
