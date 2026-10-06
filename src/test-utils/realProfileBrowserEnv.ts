/**
 * Environment for a test that launches a real system browser (Chrome or Edge)
 * through Playwright.
 *
 * isolateDataDir.ts points USERPROFILE at a temp dir on Windows so wmux's data
 * dir, and everything else that resolves os.homedir(), stays out of the real
 * profile. A Chromium browser started with that environment on the GitHub
 * Windows runner cannot resolve its local app data folder (PathService key 112,
 * DIR_LOCAL_APP_DATA), so it cannot tell whether --user-data-dir is the default
 * profile, refuses remote debugging ("DevTools remote debugging requires a
 * non-default data directory") and exits; Playwright then reports
 * "browserType.launch: Target page, context or browser has been closed".
 *
 * The browser never reads wmux state, so it gets the real profile back. The
 * vitest process itself keeps the temp USERPROFILE.
 *
 * Returns undefined off Windows or outside the isolate setup, which makes
 * Playwright fall back to process.env. Playwright's `env` option replaces the
 * child environment rather than merging it, hence the full spread.
 */
export function realProfileBrowserEnv(): NodeJS.ProcessEnv | undefined {
  const realHome = process.env.WMUX_TEST_REAL_HOME;
  if (process.platform !== 'win32' || !realHome) return undefined;
  return { ...process.env, USERPROFILE: realHome };
}
