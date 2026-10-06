import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applySurfaceChanges, previewSurfaceChanges, type WriterRegistry, type WriterDeps } from '../index';

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-writers-'));
}

function deps(home: string, version = '1.2.14'): WriterDeps {
  return {
    homeDir: home,
    run: async () => version,
    now: () => 1_000,
    surfacesStorePath: path.join(home, '.wmux', 'surfaces.json'),
  };
}

function seedAgy(home: string): void {
  const cfg = path.join(home, '.gemini', 'config');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(
    path.join(cfg, 'mcp_config.json'),
    JSON.stringify({ mcpServers: { alpha: { command: 'x' }, wmux: { command: 'node' } } }),
  );
}

function fakeWriters() {
  const apply = vi.fn(async () => ({ provider: 'agy' as const, ok: true, appliedItemIds: ['x'], backups: [], error: null }));
  const preview = vi.fn(async () => ({ provider: 'agy' as const, edits: [{ path: 'p', summary: 's' }], requiresNewSession: true }));
  const stub = { provider: 'agy' as const, preview, apply };
  return { registry: { agy: stub, codex: stub, claude: stub } as unknown as WriterRegistry, apply, preview };
}

describe('surface change dispatch', () => {
  it('rejects unknown items, already-set state and wmux items without confirmation, and calls no writer', async () => {
    const home = tempHome();
    seedAgy(home);
    const { registry, apply } = fakeWriters();
    const inv = await import('../../inventory');
    const items = (await inv.readInventory('agy', { homeDir: home, run: async () => '1.2.14' })).items;
    const alpha = items.find((i) => i.name === 'alpha' && i.kind === 'mcp-server')!;
    const wmux = items.find((i) => i.name === 'wmux' && i.kind === 'mcp-server')!;

    const preview = await previewSurfaceChanges(
      {
        provider: 'agy',
        changes: [
          { itemId: 'agy:mcp-server::missing', enabled: false },
          { itemId: alpha.id, enabled: true },
          { itemId: wmux.id, enabled: false },
        ],
      },
      { deps: deps(home), writers: registry },
    );
    expect(preview.rejected).toHaveLength(3);
    expect(preview.edits).toEqual([]);
    const result = await applySurfaceChanges(
      { provider: 'agy', changes: [{ itemId: wmux.id, enabled: false }] },
      { deps: deps(home), writers: registry },
    );
    expect(result.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('passes only validated changes to the writer and allows wmux items when confirmed', async () => {
    const home = tempHome();
    seedAgy(home);
    const { registry, apply } = fakeWriters();
    const inv = await import('../../inventory');
    const items = (await inv.readInventory('agy', { homeDir: home, run: async () => '1.2.14' })).items;
    const alpha = items.find((i) => i.name === 'alpha' && i.kind === 'mcp-server')!;
    const wmux = items.find((i) => i.name === 'wmux' && i.kind === 'mcp-server')!;
    await applySurfaceChanges(
      { provider: 'agy', changes: [{ itemId: alpha.id, enabled: false }, { itemId: wmux.id, enabled: false }], allowWmuxRequired: true },
      { deps: deps(home), writers: registry },
    );
    expect(apply).toHaveBeenCalledTimes(1);
    const ctx = (apply.mock.calls[0] as unknown as [{ changes: { item: { name: string } }[] }])[0];
    expect(ctx.changes.map((c) => c.item.name).sort()).toEqual(['alpha', 'wmux']);
  });

  it('refuses everything on an unsupported CLI version', async () => {
    const home = tempHome();
    seedAgy(home);
    const { registry, apply } = fakeWriters();
    const inv = await import('../../inventory');
    const items = (await inv.readInventory('agy', { homeDir: home, run: async () => '1.2.14' })).items;
    const alpha = items.find((i) => i.name === 'alpha' && i.kind === 'mcp-server')!;
    const result = await applySurfaceChanges(
      { provider: 'agy', changes: [{ itemId: alpha.id, enabled: false }] },
      { deps: deps(home, '9.9.9'), writers: registry },
    );
    expect(result.ok).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('turns a throwing writer into a safe failure result', async () => {
    const home = tempHome();
    seedAgy(home);
    const { registry, apply } = fakeWriters();
    apply.mockRejectedValueOnce(new Error('/secret/path leaked'));
    const inv = await import('../../inventory');
    const items = (await inv.readInventory('agy', { homeDir: home, run: async () => '1.2.14' })).items;
    const alpha = items.find((i) => i.name === 'alpha' && i.kind === 'mcp-server')!;
    const result = await applySurfaceChanges(
      { provider: 'agy', changes: [{ itemId: alpha.id, enabled: false }] },
      { deps: deps(home), writers: registry },
    );
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('secret');
  });
});
