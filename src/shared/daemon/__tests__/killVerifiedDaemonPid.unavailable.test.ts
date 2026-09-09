import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const probes = vi.hoisted(() => ({ image: '', argv: null as string | null }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: vi.fn((command: string, args: string[]) => {
    if (command.endsWith('tasklist.exe')) return `"${probes.image}","424242","Console","1","1 K"`;
    if (args.includes('comm=')) return probes.image;
    if (probes.argv === null) throw new Error('Process command-line lookup unavailable');
    return probes.argv;
  }) };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn((file: string, ...args: unknown[]) => {
    if (file === '/proc/424242/comm') return probes.image;
    if (file === '/proc/424242/cmdline') {
      if (probes.argv === null) throw new Error('Process command-line lookup unavailable');
      return probes.argv;
    }
    return Reflect.apply(actual.readFileSync, actual, [file, ...args]);
  }) };
});

import { killVerifiedDaemonPid } from '../daemonLauncherCore';

describe('killVerifiedDaemonPid — unavailable command line', () => {
  beforeEach(() => {
    probes.image = path.basename(process.execPath);
    probes.argv = null;
    // No real PID is signalled by these failure-injection tests.
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])('refuses a matching image without script identity (definitiveOnly=%s)', (definitiveOnly) => {
    expect(killVerifiedDaemonPid(424242, { definitiveOnly })).toBe(false);
    expect(process.kill).not.toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  it('also refuses an empty command-line response', () => {
    probes.argv = '';
    expect(killVerifiedDaemonPid(424242, { definitiveOnly: false })).toBe(false);
    expect(process.kill).not.toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  it.each([false, true])('still signals a verified script (definitiveOnly=%s)', (definitiveOnly) => {
    probes.argv = process.platform === 'linux'
      ? `${process.execPath}\0/test/daemon-bundle/index.js\0`
      : `"${process.execPath}" /test/daemon-bundle/index.js`;
    expect(killVerifiedDaemonPid(424242, { definitiveOnly })).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(424242, 'SIGKILL');
  });

  it.each([false, true])('requires script identity for a different host image (definitiveOnly=%s)', (definitiveOnly) => {
    probes.image = 'other-host-node';
    expect(killVerifiedDaemonPid(424242, { definitiveOnly })).toBe(false);
    expect(process.kill).not.toHaveBeenCalledWith(424242, 'SIGKILL');

    probes.argv = process.platform === 'linux'
      ? `${process.execPath}\0/test/daemon-bundle/index.js\0`
      : `"${process.execPath}" /test/daemon-bundle/index.js`;
    expect(killVerifiedDaemonPid(424242, { definitiveOnly })).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(424242, 'SIGKILL');
  });
});
