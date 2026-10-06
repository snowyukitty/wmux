import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../../shared/runCli';
import { getExecEnv } from '../../../shared/execEnv';
import type {
  ProviderInventory,
  SurfaceApplyResult,
  SurfaceChangeRequest,
  SurfacePreview,
  SurfaceProviderId,
} from '../../../shared/tokenUsage/surfaceTypes';
import { readInventory, type InventoryDeps } from '../inventory';
import { createAgyWriter } from './agyWriter';
import { createClaudeWriter } from './claudeWriter';
import { createCodexWriter } from './codexWriter';
import type { ResolvedChange, SurfaceWriter, WriterDeps } from './types';

export * from './types';

export function defaultWriterDeps(): WriterDeps {
  const homeDir = os.homedir();
  return {
    homeDir,
    run: (command, args) => runCli(command, args, { timeoutMs: 15000, maxBuffer: 65536, env: getExecEnv() }),
    now: () => Date.now(),
    surfacesStorePath: path.join(homeDir, '.wmux', 'surfaces.json'),
  };
}

export type WriterRegistry = Record<SurfaceProviderId, SurfaceWriter>;

export function defaultWriters(): WriterRegistry {
  return { codex: createCodexWriter(), agy: createAgyWriter(), claude: createClaudeWriter() };
}

interface Resolution {
  inventory: ProviderInventory;
  accepted: ResolvedChange[];
  rejected: { itemId: string; reason: string }[];
}

export interface SurfaceChangeOptions {
  deps?: WriterDeps;
  writers?: WriterRegistry;
  inventoryDeps?: Partial<InventoryDeps>;
}

async function resolve(
  request: SurfaceChangeRequest,
  deps: WriterDeps,
  inventoryDeps?: Partial<InventoryDeps>,
): Promise<Resolution> {
  const inventory = await readInventory(request.provider, {
    homeDir: deps.homeDir,
    projectDir: deps.projectDir,
    surfacesStorePath: deps.surfacesStorePath,
    run: deps.run,
    now: deps.now,
    ...inventoryDeps,
  });
  const byId = new Map(inventory.items.map((i) => [i.id, i]));
  const accepted: ResolvedChange[] = [];
  const rejected: Resolution['rejected'] = [];
  const seen = new Set<string>();
  for (const change of request.changes) {
    const reject = (reason: string) => rejected.push({ itemId: change.itemId, reason });
    if (seen.has(change.itemId)) {
      reject('Duplicate change for the same item.');
      continue;
    }
    seen.add(change.itemId);
    const item = byId.get(change.itemId);
    if (!item) reject('Item not found; the configuration changed since it was listed.');
    else if (!inventory.writable) reject('This CLI version is outside the tested range; editing is disabled.');
    else if (!item.toggleable) reject(item.readOnlyReason ?? 'This item cannot be switched.');
    else if (item.wmuxRequired && !request.allowWmuxRequired) reject('wmux needs this item; confirm to change it anyway.');
    else if (item.enabled === change.enabled) reject('Already in the requested state.');
    else accepted.push({ item, enabled: change.enabled });
  }
  return { inventory, accepted, rejected };
}

export async function previewSurfaceChanges(
  request: SurfaceChangeRequest,
  opts: SurfaceChangeOptions = {},
): Promise<SurfacePreview> {
  const deps = opts.deps ?? defaultWriterDeps();
  const { inventory, accepted, rejected } = await resolve(request, deps, opts.inventoryDeps);
  if (accepted.length === 0) return { provider: request.provider, edits: [], rejected, requiresNewSession: true };
  const writer = (opts.writers ?? defaultWriters())[request.provider];
  const preview = await writer.preview({ deps, inventory, changes: accepted });
  return { ...preview, rejected };
}

export async function applySurfaceChanges(
  request: SurfaceChangeRequest,
  opts: SurfaceChangeOptions = {},
): Promise<SurfaceApplyResult> {
  const deps = opts.deps ?? defaultWriterDeps();
  const { inventory, accepted, rejected } = await resolve(request, deps, opts.inventoryDeps);
  if (accepted.length === 0) {
    const error = rejected[0]?.reason ?? 'Nothing to change.';
    return { provider: request.provider, ok: false, appliedItemIds: [], backups: [], error };
  }
  const writer = (opts.writers ?? defaultWriters())[request.provider];
  try {
    return await writer.apply({ deps, inventory, changes: accepted });
  } catch {
    return {
      provider: request.provider,
      ok: false,
      appliedItemIds: [],
      backups: [],
      error: 'Applying the change failed; no file was left half-written.',
    };
  }
}
