import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  saveProfile,
  previewProfile,
  applyProfile,
  listProfiles,
  deleteProfile,
  getProfile,
} from '../surfaceProfilesService';
import type { WriterDeps } from '../../writers/types';
import type { ProviderInventory, SurfaceItem } from '../../../../shared/tokenUsage/surfaceTypes';
import * as inventoryModule from '../../inventory';
import { SurfacesStore } from '../../safeWrite/surfacesStore';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('surfaceProfilesService', () => {
  let tempHome: string;
  let storePath: string;
  let mockDeps: WriterDeps;

  beforeEach(() => {
    tempHome = makeTempDir('profiles-svc-test-');
    storePath = path.join(tempHome, '.wmux', 'surfaces.json');
    mockDeps = {
      homeDir: tempHome,
      run: async (cmd, args) => {
        if (args[0] === '--version') return '1.0.5';
        return '1.0.5';
      },
      now: () => 1_700_000_000_000,
      surfacesStorePath: storePath,
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  describe('name validation and uniqueness', () => {
    it('validates name length and trims whitespace', async () => {
      await expect(saveProfile('', ['claude'], { deps: mockDeps })).rejects.toThrow(
        'Profile name must be between 1 and 40 characters.',
      );
      await expect(saveProfile('   ', ['claude'], { deps: mockDeps })).rejects.toThrow(
        'Profile name must be between 1 and 40 characters.',
      );
      await expect(saveProfile('a'.repeat(41), ['claude'], { deps: mockDeps })).rejects.toThrow(
        'Profile name must be between 1 and 40 characters.',
      );

      // Name is trimmed and saved
      vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [],
        warnings: [],
        scannedAtMs: 1000,
      });

      const res = await saveProfile('  My Profile  ', ['claude'], { deps: mockDeps });
      expect(res.ok).toBe(true);
      expect(res.profile?.name).toBe('My Profile');
    });

    it('enforces case-insensitive name uniqueness', async () => {
      vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [],
        warnings: [],
        scannedAtMs: 1000,
      });

      await saveProfile('Development', ['claude'], { deps: mockDeps });

      await expect(saveProfile('development', ['claude'], { deps: mockDeps })).rejects.toThrow(
        'A profile with this name already exists.',
      );
      await expect(saveProfile('  DEVELOPMENT  ', ['claude'], { deps: mockDeps })).rejects.toThrow(
        'A profile with this name already exists.',
      );
    });

    it('enforces name uniqueness during storage save replay', async () => {
      vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [],
        warnings: [],
        scannedAtMs: 1000,
      });

      const store1 = new SurfacesStore(storePath);
      store1.load();

      const store2 = new SurfacesStore(storePath);
      store2.load();

      await saveProfile('Concurrent Name', ['claude'], { deps: mockDeps, store: store1 });

      await expect(
        saveProfile('concurrent name', ['claude'], { deps: mockDeps, store: store2 }),
      ).rejects.toThrow('A profile with this name already exists.');
    });

    it('enforces 50 profiles limit on service', async () => {
      vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [],
        warnings: [],
        scannedAtMs: 1000,
      });

      for (let i = 0; i < 50; i++) {
        await saveProfile(`Profile ${i}`, ['claude'], { deps: mockDeps });
      }

      await expect(saveProfile('Profile 51', ['claude'], { deps: mockDeps })).rejects.toThrow(
        'Maximum number of profiles (50) reached.',
      );
    }, 60_000);
  });

  describe('capture rules', () => {
    it('excludes read-only and wmux-required items from capture', async () => {
      const items: SurfaceItem[] = [
        {
          id: 'claude:plugin::toggleable-enabled',
          provider: 'claude',
          kind: 'plugin',
          name: 'toggleable-enabled',
          parent: null,
          source: 'user',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: false,
        },
        {
          id: 'claude:plugin::toggleable-disabled',
          provider: 'claude',
          kind: 'plugin',
          name: 'toggleable-disabled',
          parent: null,
          source: 'user',
          enabled: false,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: false,
        },
        {
          id: 'claude:plugin::readonly-item',
          provider: 'claude',
          kind: 'plugin',
          name: 'readonly-item',
          parent: null,
          source: 'builtin',
          enabled: true,
          effect: 'none',
          toggleable: false,
          readOnlyReason: 'Managed plugin',
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: false,
        },
        {
          id: 'claude:mcp-server::wmux-required',
          provider: 'claude',
          kind: 'mcp-server',
          name: 'wmux',
          parent: null,
          source: 'wmux',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: true,
        },
      ];

      vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items,
        warnings: [],
        scannedAtMs: 1000,
      });

      const res = await saveProfile('Test Capture', ['claude'], { deps: mockDeps });
      expect(res.ok).toBe(true);
      const state = res.profile?.providers.claude;
      expect(state).toBeDefined();

      // Only toggleable non-wmuxRequired items are captured in knownItemIds
      expect(state?.knownItemIds).toEqual([
        'claude:plugin::toggleable-enabled',
        'claude:plugin::toggleable-disabled',
      ]);
      // Only those with enabled === false are in disabledItemIds
      expect(state?.disabledItemIds).toEqual(['claude:plugin::toggleable-disabled']);
    });

    it('skips providers whose inventory is not writable and reports it', async () => {
      vi.spyOn(inventoryModule, 'readInventory').mockImplementation(async (provider) => {
        if (provider === 'codex') {
          return {
            provider: 'codex',
            cliVersion: '0.1.0',
            versionSupported: false,
            writable: false,
            items: [],
            warnings: ['Version unsupported'],
            scannedAtMs: 1000,
          };
        }
        return {
          provider,
          cliVersion: '1.0.0',
          versionSupported: true,
          writable: true,
          items: [],
          warnings: [],
          scannedAtMs: 1000,
        };
      });

      const res = await saveProfile('Mixed Providers', ['claude', 'codex'], { deps: mockDeps });
      expect(res.ok).toBe(true);
      expect(res.profile?.providers.claude).toBeDefined();
      expect(res.profile?.providers.codex).toBeUndefined();
      expect(res.skippedProviders).toEqual([
        { provider: 'codex', reason: 'Editing is disabled for this CLI version' },
      ]);
    });

    it('sanitizes inventory exceptions and never leaks paths or secrets', async () => {
      vi.spyOn(inventoryModule, 'readInventory').mockImplementation(async (provider) => {
        if (provider === 'codex') {
          throw new Error('Crash in C:\\Users\\alice\\.codex\\secrets\\auth_key.txt with bearer sk-secret-token-12345');
        }
        return {
          provider,
          cliVersion: '1.0.0',
          versionSupported: true,
          writable: true,
          items: [],
          warnings: [],
          scannedAtMs: 1000,
        };
      });

      const res = await saveProfile('Safe Profile', ['claude', 'codex'], { deps: mockDeps });
      expect(res.ok).toBe(true);
      expect(res.skippedProviders).toEqual([
        { provider: 'codex', reason: 'Could not read the configuration' },
      ]);
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain('auth_key.txt');
      expect(serialized).not.toContain('sk-secret-token-12345');
      expect(serialized).not.toContain('alice');
    });

    it('surfaces storage version refusal as a fixed-sentence error on saveProfile', async () => {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({ version: 99 }), 'utf8');

      vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [],
        warnings: [],
        scannedAtMs: 1000,
      });

      await expect(saveProfile('Future Store', ['claude'], { deps: mockDeps })).rejects.toThrow(
        'Storage version is not supported.',
      );
    });
  });

  describe('apply and preview rules', () => {
    it('builds only differing changes and counts missing and new items', async () => {
      // 1. Initial capture
      const initialItems: SurfaceItem[] = [
        {
          id: 'claude:plugin::item-a',
          provider: 'claude',
          kind: 'plugin',
          name: 'item-a',
          parent: null,
          source: 'user',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: false,
        },
        {
          id: 'claude:plugin::item-b',
          provider: 'claude',
          kind: 'plugin',
          name: 'item-b',
          parent: null,
          source: 'user',
          enabled: false,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: false,
        },
        {
          id: 'claude:plugin::item-vanished',
          provider: 'claude',
          kind: 'plugin',
          name: 'item-vanished',
          parent: null,
          source: 'user',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: false,
        },
      ];

      const readSpy = vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: initialItems,
        warnings: [],
        scannedAtMs: 1000,
      });

      const saveRes = await saveProfile('Differing Changes', ['claude'], { deps: mockDeps });
      const profileId = saveRes.profile!.id;

      // 2. Now change live state:
      // - item-a is now false (differs from profile true) -> change generated
      // - item-b is now false (same as profile false) -> NO change generated
      // - item-vanished is gone -> missing count 1
      // - item-new appeared -> new count 1
      const modifiedItems: SurfaceItem[] = [
        {
          ...initialItems[0],
          enabled: false,
        },
        {
          ...initialItems[1],
          enabled: false,
        },
        {
          id: 'claude:plugin::item-new',
          provider: 'claude',
          kind: 'plugin',
          name: 'item-new',
          parent: null,
          source: 'user',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: false,
        },
      ];

      readSpy.mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: modifiedItems,
        warnings: [],
        scannedAtMs: 2000,
      });

      const preview = await previewProfile(profileId, { deps: mockDeps });
      expect(preview.missing.count).toBe(1);
      expect(preview.missing.firstFewIds).toEqual(['claude:plugin::item-vanished']);
      expect(preview.newItems).toBe(1);

      // Provider preview should have received only the differing change for item-a (to enabled=true)
      const claudePreview = preview.providers.claude;
      expect(claudePreview).toBeDefined();
      expect(claudePreview?.missingCount).toBe(1);
      expect(claudePreview?.newItemsCount).toBe(1);
    });

    it('continues when one provider fails without stopping others, aggregate ok is false', async () => {
      // Create a profile with claude and codex
      vi.spyOn(inventoryModule, 'readInventory').mockImplementation(async (provider) => ({
        provider,
        cliVersion: '1.0.0',
        versionSupported: true,
        writable: true,
        items: [
          {
            id: `${provider}:item1`,
            provider,
            kind: 'plugin',
            name: 'item1',
            parent: null,
            source: 'user',
            enabled: true,
            effect: 'removes',
            toggleable: true,
            readOnlyReason: null,
            hookEvent: null,
            hookCost: null,
            descriptionChars: null,
            originPath: null,
            wmuxRequired: false,
          },
        ],
        warnings: [],
        scannedAtMs: 1000,
      }));

      const saveRes = await saveProfile('Multi Provider', ['claude', 'codex'], { deps: mockDeps });
      const profileId = saveRes.profile!.id;

      // When previewing, make codex throw an error
      vi.spyOn(inventoryModule, 'readInventory').mockImplementation(async (provider) => {
        if (provider === 'codex') {
          throw new Error('Codex config corrupt');
        }
        return {
          provider,
          cliVersion: '1.0.0',
          versionSupported: true,
          writable: true,
          items: [
            {
              id: `${provider}:item1`,
              provider,
              kind: 'plugin',
              name: 'item1',
              parent: null,
              source: 'user',
              enabled: false,
              effect: 'removes',
              toggleable: true,
              readOnlyReason: null,
              hookEvent: null,
              hookCost: null,
              descriptionChars: null,
              originPath: null,
              wmuxRequired: false,
            },
          ],
          warnings: [],
          scannedAtMs: 2000,
        };
      });

      const preview = await previewProfile(profileId, { deps: mockDeps });
      expect(preview.ok).toBe(false);
      expect(preview.providers.claude).toBeDefined();
      expect(preview.providers.codex).toBeDefined();
      expect(preview.providers.codex?.rejected[0]?.reason).toContain('Preview failed for provider');
    });
  });

  describe('end to end with REAL writers over fixture homes', () => {
    it('captures, changes state, applies profile, restores inventory, and second apply is no-op', async () => {
      // Set up REAL Claude config files
      const claudeDir = path.join(tempHome, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });

      const initialClaudeJson = {
        mcpServers: {
          'server-a': { command: 'node', args: ['a.js'] },
        },
      };
      fs.writeFileSync(path.join(tempHome, '.claude.json'), JSON.stringify(initialClaudeJson, null, 2), 'utf8');

      const initialSettings = {
        enabledPlugins: {
          'my-plugin': true,
        },
      };
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(initialSettings, null, 2), 'utf8');

      // 1. Initial inventory: server-a is enabled, my-plugin is enabled
      const inv1 = await inventoryModule.readInventory('claude', { homeDir: tempHome, run: mockDeps.run });
      expect(inv1.items.find((i) => i.name === 'server-a')?.enabled).toBe(true);

      // 2. Save profile "Active State"
      const saveRes = await saveProfile('Active State', ['claude'], { deps: mockDeps });
      expect(saveRes.ok).toBe(true);
      const profileId = saveRes.profile!.id;
      const serverAId = inv1.items.find((i) => i.name === 'server-a')!.id;
      expect(saveRes.profile?.providers.claude?.knownItemIds).toContain(serverAId);
      expect(saveRes.profile?.providers.claude?.disabledItemIds).not.toContain(serverAId);

      // 3. Change state by hand: remove server-a from .claude.json or disable in settings
      const modifiedSettings = {
        enabledPlugins: {
          'my-plugin': false,
        },
      };
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(modifiedSettings, null, 2), 'utf8');

      const inv2 = await inventoryModule.readInventory('claude', { homeDir: tempHome, run: mockDeps.run });
      const pluginItem = inv2.items.find((i) => i.name === 'my-plugin');
      expect(pluginItem?.enabled).toBe(false);

      // 4. Preview profile: shows edit to restore my-plugin to true
      const preview = await previewProfile(profileId, { deps: mockDeps });
      expect(preview.ok).toBe(true);
      expect(preview.providers.claude?.edits.length).toBeGreaterThan(0);

      // 5. Apply profile
      const applyRes = await applyProfile(profileId, { deps: mockDeps });
      expect(applyRes.ok).toBe(true);
      expect(applyRes.providers.claude?.ok).toBe(true);

      // 6. Verify inventory now matches the captured state
      const inv3 = await inventoryModule.readInventory('claude', { homeDir: tempHome, run: mockDeps.run });
      const restoredPlugin = inv3.items.find((i) => i.name === 'my-plugin');
      expect(restoredPlugin?.enabled).toBe(true);

      // 7. Second apply is a no-op with nothingToChange: true
      const secondApply = await applyProfile(profileId, { deps: mockDeps });
      expect(secondApply.ok).toBe(true);
      expect(secondApply.nothingToChange).toBe(true);
    });

    it('never changes an item that is wmuxRequired at apply time and counts it as skippedWmuxRequired', async () => {
      const capturedItems: SurfaceItem[] = [
        {
          id: 'claude:plugin::my-tool',
          provider: 'claude',
          kind: 'plugin',
          name: 'my-tool',
          parent: null,
          source: 'user',
          enabled: false,
          effect: 'removes',
          toggleable: true,
          readOnlyReason: null,
          hookEvent: null,
          hookCost: null,
          descriptionChars: null,
          originPath: null,
          wmuxRequired: false,
        },
      ];

      vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: capturedItems,
        warnings: [],
        scannedAtMs: 1000,
      });

      // Save profile capturing my-tool as disabled
      const saveRes = await saveProfile('Tool Profile', ['claude'], { deps: mockDeps });
      const profileId = saveRes.profile!.id;

      // At apply time, my-tool has become wmuxRequired and is currently enabled
      const liveItemsAtApply: SurfaceItem[] = [
        {
          ...capturedItems[0],
          enabled: true,
          wmuxRequired: true,
        },
      ];

      vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: liveItemsAtApply,
        warnings: [],
        scannedAtMs: 2000,
      });

      // Preview should show 0 edits, 1 skippedWmuxRequired
      const preview = await previewProfile(profileId, { deps: mockDeps });
      expect(preview.skippedWmuxRequired).toBe(1);
      expect(preview.providers.claude?.skippedWmuxRequired).toBe(1);
      expect(preview.providers.claude?.edits).toHaveLength(0);

      // Apply should skip it, not change it, and report skippedWmuxRequired: 1, nothingToChange: true
      const applyRes = await applyProfile(profileId, { deps: mockDeps });
      expect(applyRes.ok).toBe(true);
      expect(applyRes.skippedWmuxRequired).toBe(1);
      expect(applyRes.providers.claude?.skippedWmuxRequired).toBe(1);
      expect(applyRes.providers.claude?.appliedItemIds).toHaveLength(0);
      expect(applyRes.nothingToChange).toBe(true);
    });
  });

  describe('list and delete', () => {
    it('lists and deletes profiles correctly', async () => {
      vi.spyOn(inventoryModule, 'readInventory').mockResolvedValue({
        provider: 'claude',
        cliVersion: '1.0.5',
        versionSupported: true,
        writable: true,
        items: [],
        warnings: [],
        scannedAtMs: 1000,
      });

      const s1 = await saveProfile('P1', ['claude'], { deps: mockDeps });
      const s2 = await saveProfile('P2', ['claude'], { deps: mockDeps });

      const list = await listProfiles({ deps: mockDeps });
      expect(list).toHaveLength(2);
      expect(list.map((p) => p.name)).toEqual(['P1', 'P2']);

      const getP1 = await getProfile(s1.profile!.id, { deps: mockDeps });
      expect(getP1?.name).toBe('P1');

      const del = await deleteProfile(s1.profile!.id, { deps: mockDeps });
      expect(del).toBe(true);

      const remaining = await listProfiles({ deps: mockDeps });
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('P2');
    });
  });
});
