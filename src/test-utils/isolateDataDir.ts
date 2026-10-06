import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Save the real home before overriding; do not overwrite if already set.
if (!process.env.WMUX_TEST_REAL_HOME) {
  process.env.WMUX_TEST_REAL_HOME = os.homedir();
}

// mkdtempSync a directory under os.tmpdir() ('wmux-test-'), set HOME and USERPROFILE,
// and default WMUX_DATA_SUFFIX to '-vitest'.
// realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var. Code that
// resolves paths (resolveBrowserExportPath) returns the /private form, so a HOME
// left in the symlinked form would never compare equal to what it computes.
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-test-')));
process.env.HOME = tempDir;
// USERPROFILE only exists on Windows. getWmuxHomeDir() prefers USERPROFILE over
// HOME, so defining it on POSIX would shadow a test's own HOME override (a test
// that points HOME at its fixture dir would silently read the wrong directory).
if (process.platform === 'win32') process.env.USERPROFILE = tempDir;
process.env.WMUX_DATA_SUFFIX ??= '-vitest';
// Read by assertNotLiveWmuxDataDir: without this marker a vitest run refuses the
// live data dir even when HOME was never overridden.
process.env.WMUX_TEST_ISOLATED = '1';

// Register best-effort removal of the temp dir on process exit (never throw).
process.once('exit', () => {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup on exit; never throw.
  }
});
