import os from 'node:os';
import * as fs from 'node:fs/promises';
import { runCli } from '../../../shared/runCli';
import { getExecEnv } from '../../../shared/execEnv';
import type { ProviderInventory, SurfaceProviderId } from '../../../shared/tokenUsage/surfaceTypes';
import { readAgyInventory } from './agyInventory';
import { readClaudeInventory } from './claudeInventory';
import { readCodexInventory } from './codexInventory';
import type { InventoryDeps } from './types';

export * from './types';
export * from './helpers';
export { readAgyInventory } from './agyInventory';
export { readClaudeInventory } from './claudeInventory';
export { readCodexInventory } from './codexInventory';

export function defaultInventoryDeps(): InventoryDeps {
  return {
    homeDir: os.homedir(),
    run: (command, args) =>
      runCli(command, args, {
        timeoutMs: 3000,
        maxBuffer: 16384,
        env: getExecEnv(),
      }),
    now: () => Date.now(),
    readFile: (p, encoding) => fs.readFile(p, encoding),
    readdir: (p) => fs.readdir(p),
    stat: async (p) => {
      const s = await fs.stat(p);
      return { isDirectory: () => s.isDirectory(), isFile: () => s.isFile() };
    },
    exists: async (p) => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function readInventory(
  provider: SurfaceProviderId,
  deps?: Partial<InventoryDeps>,
): Promise<ProviderInventory> {
  const defaults = defaultInventoryDeps();
  const resolvedDeps: InventoryDeps = {
    ...defaults,
    ...deps,
    homeDir: deps?.homeDir ?? defaults.homeDir,
  };

  switch (provider) {
    case 'claude':
      return readClaudeInventory(resolvedDeps);
    case 'codex':
      return readCodexInventory(resolvedDeps);
    case 'agy':
      return readAgyInventory(resolvedDeps);
    default:
      throw new Error(`Unknown provider: ${String(provider)}`);
  }
}
