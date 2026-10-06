import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderInventory, SurfaceProviderId } from '../../../shared/tokenUsage/surfaceTypes';
import { readInventory as defaultReadInventory, type InventoryDeps } from '../inventory';
import { SurfacesStore } from '../safeWrite/surfacesStore';
import type { SurfaceDriftedItem, SurfaceReconcileResult } from './types';

export interface ReconcileDeps {
  inventoryDeps?: Partial<InventoryDeps>;
  store?: SurfacesStore;
  storePath?: string;
  readInventory?: (
    provider: SurfaceProviderId,
    deps?: Partial<InventoryDeps>,
  ) => Promise<ProviderInventory>;
}

const VALID_PROVIDERS: readonly SurfaceProviderId[] = ['claude', 'codex', 'agy'] as const;

export async function reconcileSurface(
  provider: SurfaceProviderId,
  deps?: ReconcileDeps,
): Promise<SurfaceReconcileResult> {
  if (typeof provider !== 'string' || !VALID_PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider: ${String(provider)}`);
  }

  let inventory: ProviderInventory;
  try {
    const reader = deps?.readInventory ?? defaultReadInventory;
    inventory = await reader(provider, deps?.inventoryDeps);
  } catch {
    throw new Error('Failed to reconcile surface.');
  }

  let store: SurfacesStore;
  if (deps?.store) {
    store = deps.store;
  } else {
    const storePath =
      deps?.storePath ??
      path.join(deps?.inventoryDeps?.homeDir ?? os.homedir(), '.wmux', 'surfaces.json');
    store = new SurfacesStore(storePath);
    try {
      store.load();
    } catch {
      throw new Error('Failed to reconcile surface.');
    }
  }

  const recordedMap: Record<string, boolean> =
    (store as unknown as { intents?: Record<string, Record<string, boolean>> }).intents?.[provider] ?? {};
  const recordedIds = Object.keys(recordedMap);

  if (recordedIds.length === 0) {
    return {
      newItems: 0,
      removedItems: 0,
      driftedItems: [],
      driftedCount: 0,
      truncated: false,
    };
  }

  const currentItemIds = inventory.items.map((i) => i.id);
  const liveMap = new Map(inventory.items.map((i) => [i.id, i]));

  const { newItems, removedItems } = store.reconcile(provider, currentItemIds);

  const drifted: SurfaceDriftedItem[] = [];
  for (const itemId of recordedIds) {
    const wanted = recordedMap[itemId];
    const item = liveMap.get(itemId);
    if (!item) continue;
    const actual = item.enabled !== false;
    if (actual !== wanted) {
      drifted.push({
        itemId: item.id,
        name: item.name,
        kind: item.kind,
        wanted,
        actual,
      });
    }
  }

  const MAX_DRIFTED = 200;
  const driftedCount = drifted.length;
  const truncated = driftedCount > MAX_DRIFTED;
  const driftedItems = truncated ? drifted.slice(0, MAX_DRIFTED) : drifted;

  return {
    newItems: newItems.length,
    removedItems: removedItems.length,
    driftedItems,
    driftedCount,
    truncated,
  };
}
