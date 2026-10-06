import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { reconcileSurface } from '../reconcileSurface';
import { SurfacesStore } from '../../safeWrite/surfacesStore';
import type { ProviderInventory, SurfaceItem } from '../../../../shared/tokenUsage/surfaceTypes';

function makeItem(id: string, name: string, enabled = true): SurfaceItem {
  return {
    id,
    provider: 'claude',
    kind: 'mcp-tool',
    name,
    parent: 'server-1',
    source: 'user',
    enabled,
    effect: 'removes',
    toggleable: true,
    readOnlyReason: null,
    hookEvent: null,
    hookCost: null,
    descriptionChars: null,
    originPath: null,
    wmuxRequired: false,
  };
}

function makeInventory(items: SurfaceItem[]): ProviderInventory {
  return {
    provider: 'claude',
    cliVersion: '1.0.0',
    versionSupported: true,
    writable: true,
    items,
    warnings: [],
    scannedAtMs: Date.now(),
  };
}

describe('reconcileSurface', () => {
  it('fixture: nothing — returns 0 new, 0 removed, 0 drifted when live matches intent', async () => {
    const tmpFile = path.join(os.tmpdir(), `reconcile-test-nothing-${Date.now()}.json`);
    const store = new SurfacesStore(tmpFile);
    store.recordIntent('claude', 'item-1', true);
    store.recordIntent('claude', 'item-2', false);

    const inventory = makeInventory([
      makeItem('item-1', 'Tool 1', true),
      makeItem('item-2', 'Tool 2', false),
    ]);

    const result = await reconcileSurface('claude', {
      store,
      readInventory: async () => inventory,
    });

    expect(result).toEqual({
      newItems: 0,
      removedItems: 0,
      driftedItems: [],
      driftedCount: 0,
      truncated: false,
    });
  });

  it('fixture: nothing — returns 0 new, 0 removed, 0 drifted when store has no recorded intents', async () => {
    const tmpFile = path.join(os.tmpdir(), `reconcile-test-empty-${Date.now()}.json`);
    const store = new SurfacesStore(tmpFile);

    const inventory = makeInventory([
      makeItem('item-1', 'Tool 1', true),
      makeItem('item-2', 'Tool 2', false),
    ]);

    const result = await reconcileSurface('claude', {
      store,
      readInventory: async () => inventory,
    });

    expect(result).toEqual({
      newItems: 0,
      removedItems: 0,
      driftedItems: [],
      driftedCount: 0,
      truncated: false,
    });
  });

  it('fixture: drift — detects items changed outside wmux away from wanted state', async () => {
    const tmpFile = path.join(os.tmpdir(), `reconcile-test-drift-${Date.now()}.json`);
    const store = new SurfacesStore(tmpFile);
    store.recordIntent('claude', 'item-1', false); // wmux wanted it off
    store.recordIntent('claude', 'item-2', true); // wmux wanted it on

    const inventory = makeInventory([
      makeItem('item-1', 'Tool 1', true), // user or CLI turned it on
      makeItem('item-2', 'Tool 2', false), // user or CLI turned it off
    ]);

    const result = await reconcileSurface('claude', {
      store,
      readInventory: async () => inventory,
    });

    expect(result.newItems).toBe(0);
    expect(result.removedItems).toBe(0);
    expect(result.driftedCount).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.driftedItems).toEqual([
      {
        itemId: 'item-1',
        name: 'Tool 1',
        kind: 'mcp-tool',
        wanted: false,
        actual: true,
      },
      {
        itemId: 'item-2',
        name: 'Tool 2',
        kind: 'mcp-tool',
        wanted: true,
        actual: false,
      },
    ]);
  });

  it('fixture: new — detects new items added since last applied choices', async () => {
    const tmpFile = path.join(os.tmpdir(), `reconcile-test-new-${Date.now()}.json`);
    const store = new SurfacesStore(tmpFile);
    store.recordIntent('claude', 'item-1', true);

    const inventory = makeInventory([
      makeItem('item-1', 'Tool 1', true),
      makeItem('item-brand-new', 'Brand New Tool', true),
    ]);

    const result = await reconcileSurface('claude', {
      store,
      readInventory: async () => inventory,
    });

    expect(result.newItems).toBe(1);
    expect(result.removedItems).toBe(0);
    expect(result.driftedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.driftedItems).toEqual([]);
  });

  it('fixture: removed — detects items deleted upstream that were previously recorded', async () => {
    const tmpFile = path.join(os.tmpdir(), `reconcile-test-removed-${Date.now()}.json`);
    const store = new SurfacesStore(tmpFile);
    store.recordIntent('claude', 'item-1', true);
    store.recordIntent('claude', 'item-deleted', false);

    const inventory = makeInventory([
      makeItem('item-1', 'Tool 1', true),
    ]);

    const result = await reconcileSurface('claude', {
      store,
      readInventory: async () => inventory,
    });

    expect(result.newItems).toBe(0);
    expect(result.removedItems).toBe(1);
    expect(result.driftedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.driftedItems).toEqual([]);
  });

  it('caps driftedItems at a maximum of 200 entries and reports driftedCount and truncated', async () => {
    const tmpFile = path.join(os.tmpdir(), `reconcile-test-cap-${Date.now()}.json`);
    const store = new SurfacesStore(tmpFile);

    const items: SurfaceItem[] = [];
    for (let i = 0; i < 250; i++) {
      const id = `item-${i}`;
      store.recordIntent('claude', id, false);
      items.push(makeItem(id, `Tool ${i}`, true)); // all 250 drifted
    }

    const inventory = makeInventory(items);

    const result = await reconcileSurface('claude', {
      store,
      readInventory: async () => inventory,
    });

    expect(result.driftedCount).toBe(250);
    expect(result.truncated).toBe(true);
    expect(result.driftedItems).toHaveLength(200);
    expect(result.driftedItems[0].itemId).toBe('item-0');
    expect(result.driftedItems[199].itemId).toBe('item-199');
  });

  it('rejects unknown provider with fixed error message', async () => {
    await expect(reconcileSurface('unknown' as any)).rejects.toThrow('Unknown provider: unknown');
  });

  it('returns fixed-sentence error if inventory reading throws', async () => {
    const tmpFile = path.join(os.tmpdir(), `reconcile-test-err-${Date.now()}.json`);
    const store = new SurfacesStore(tmpFile);

    await expect(
      reconcileSurface('claude', {
        store,
        readInventory: async () => {
          throw new Error('Disk read failure with raw internal path');
        },
      }),
    ).rejects.toThrow('Failed to reconcile surface.');
  });
});
