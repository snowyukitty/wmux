import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeSurfaceItemId, readInventory } from '../index';

describe('readInventory', () => {
  it('generates correct URI-encoded stable ids', () => {
    const idWithParent = makeSurfaceItemId('claude', 'mcp-tool', 'my server', 'my tool:special');
    expect(idWithParent).toBe('claude:mcp-tool:my%20server:my%20tool%3Aspecial');

    const idWithoutParent = makeSurfaceItemId('agy', 'skill', null, 'hello/world');
    expect(idWithoutParent).toBe('agy:skill::hello%2Fworld');
  });

  it('routes correctly to claude, codex, agy and rejects unknown provider', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-inventory-test-'));

    try {
      const deps = {
        homeDir: tempDir,
        run: async (cmd: string) => {
          if (cmd === 'claude') return '1.0.0';
          if (cmd === 'codex') return '0.159.2';
          if (cmd === 'agy') return '1.2.14';
          return '0.0.0';
        },
      };

      const claudeInv = await readInventory('claude', deps);
      expect(claudeInv.provider).toBe('claude');

      const codexInv = await readInventory('codex', deps);
      expect(codexInv.provider).toBe('codex');

      const agyInv = await readInventory('agy', deps);
      expect(agyInv.provider).toBe('agy');

      // Reject unknown provider
      await expect(
        readInventory('unknown-provider' as any, deps),
      ).rejects.toThrow('Unknown provider: unknown-provider');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('allocates unique deterministic ids when base ids collide across locations', async () => {
    const { allocateUniqueItemId } = await import('../types');
    const seen = new Set<string>();

    const baseId = makeSurfaceItemId('claude', 'skill', null, 'my-skill');
    // First item keeps contract id
    const id1 = allocateUniqueItemId(seen, baseId, 'user');
    expect(id1).toBe('claude:skill::my-skill');

    // Second item (project collision) appends @source
    const id2 = allocateUniqueItemId(seen, baseId, 'project');
    expect(id2).toBe('claude:skill::my-skill@project');

    // Third item (builtin collision) appends @source
    const id3 = allocateUniqueItemId(seen, baseId, 'builtin');
    expect(id3).toBe('claude:skill::my-skill@builtin');

    // Fourth item (another project collision) appends @source#2
    const id4 = allocateUniqueItemId(seen, baseId, 'project');
    expect(id4).toBe('claude:skill::my-skill@project#2');

    // Fifth item (another project collision) appends @source#3
    const id5 = allocateUniqueItemId(seen, baseId, 'project');
    expect(id5).toBe('claude:skill::my-skill@project#3');

    // Sixth item (second user collision) appends @source
    const id6 = allocateUniqueItemId(seen, baseId, 'user');
    expect(id6).toBe('claude:skill::my-skill@user');

    // Seventh item (third user collision) appends @source#2
    const id7 = allocateUniqueItemId(seen, baseId, 'user');
    expect(id7).toBe('claude:skill::my-skill@user#2');
  });
});
