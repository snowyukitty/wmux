import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SurfacesStore } from '../surfacesStore';

describe('SurfacesStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-store-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('performs round-trip of intents and removedHooks', () => {
    const filePath = path.join(tmpDir, 'surfaces.json');
    const store = new SurfacesStore(filePath);

    store.recordIntent('claude', 'mcp__wmux__browser', false);
    store.recordIntent('codex', 'web_search', true);
    store.removedHooks.add('claude', {
      id: 'hook-1',
      definition: { type: 'prompt', prompt: 'test' },
      originPath: '/home/.claude/settings.json',
    });

    store.save();
    expect(fs.existsSync(filePath)).toBe(true);

    const store2 = new SurfacesStore(filePath);
    store2.load();

    expect(store2.getIntent('claude', 'mcp__wmux__browser')).toBe(false);
    expect(store2.getIntent('codex', 'web_search')).toBe(true);
    expect(store2.getIntent('agy', 'unknown')).toBeUndefined();

    const taken = store2.removedHooks.take('claude', 'hook-1');
    expect(taken).toEqual({
      id: 'hook-1',
      definition: { type: 'prompt', prompt: 'test' },
      originPath: '/home/.claude/settings.json',
    });
    // Second take returns undefined
    expect(store2.removedHooks.take('claude', 'hook-1')).toBeUndefined();
  });

  it('treats corrupt file as empty and reports warning without throwing', () => {
    const filePath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(filePath, '{\ninvalid json here', 'utf8');

    const store = new SurfacesStore(filePath);
    expect(() => store.load()).not.toThrow();

    expect(store.warnings.length).toBeGreaterThan(0);
    expect(store.warnings[0]).toContain('Corrupt surfaces store');
    expect(store.getIntent('claude', 'anything')).toBeUndefined();
  });

  it('refuses to overwrite future-version files and reports warning', () => {
    const filePath = path.join(tmpDir, 'future.json');
    const futurePayload = {
      version: 99,
      intents: { claude: { futureFeature: true } },
    };
    fs.writeFileSync(filePath, JSON.stringify(futurePayload), 'utf8');

    const store = new SurfacesStore(filePath);
    expect(() => store.load()).not.toThrow();

    expect(store.warnings.length).toBeGreaterThan(0);
    expect(store.warnings[0]).toContain('Unknown or unsupported surfaces store version: 99');
    expect(store.getIntent('claude', 'futureFeature')).toBeUndefined();

    // Now try to save
    store.recordIntent('claude', 'localIntent', true);
    expect(() => store.save()).toThrow(/refusing to save/i);

    expect(store.warnings.some((w) => w.includes('Refusing to save'))).toBe(true);

    // Verify on disk: file must still have version 99 untouched
    const diskContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(diskContent.version).toBe(99);
    expect(diskContent.intents.claude.futureFeature).toBe(true);
    expect(diskContent.intents.claude.localIntent).toBeUndefined();
  });

  it('reconciles recorded items with currently seen items', () => {
    const filePath = path.join(tmpDir, 'reconcile.json');
    const store = new SurfacesStore(filePath);

    store.recordIntent('claude', 'item-existing', true);
    store.recordIntent('claude', 'item-deleted-upstream', false);

    const { newItems, removedItems } = store.reconcile('claude', [
      'item-existing',
      'item-new-detected',
    ]);

    expect(newItems).toEqual(['item-new-detected']);
    expect(removedItems).toEqual(['item-deleted-upstream']);
  });

  it('performs round-trip of profiles', () => {
    const filePath = path.join(tmpDir, 'profiles.json');
    const store = new SurfacesStore(filePath);

    store.profiles.add({
      id: 'prof-1',
      name: 'Full dev',
      createdAt: 1700000000000,
      providers: {
        claude: {
          knownItemIds: ['claude:plugin::git', 'claude:plugin::bash'],
          disabledItemIds: ['claude:plugin::bash'],
        },
      },
    });

    store.save();
    expect(fs.existsSync(filePath)).toBe(true);

    const store2 = new SurfacesStore(filePath);
    store2.load();

    const list = store2.profiles.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: 'prof-1',
      name: 'Full dev',
      createdAt: 1700000000000,
      providers: {
        claude: {
          knownItemIds: ['claude:plugin::git', 'claude:plugin::bash'],
          disabledItemIds: ['claude:plugin::bash'],
        },
      },
    });
    expect(store2.profiles.get('prof-1')?.name).toBe('Full dev');
    expect(store2.profiles.getByName('full dev')?.id).toBe('prof-1');
  });

  it('handles file without profiles key gracefully and preserves unknown top-level keys', () => {
    const filePath = path.join(tmpDir, 'unknown-keys.json');
    const diskPayload = {
      version: 1,
      intents: { codex: { item1: true } },
      customKey: 'preservedValue',
      metadata: { author: 'test' },
    };
    fs.writeFileSync(filePath, JSON.stringify(diskPayload), 'utf8');

    const store = new SurfacesStore(filePath);
    store.load();

    expect(store.profiles.list()).toEqual([]);
    expect(store.getIntent('codex', 'item1')).toBe(true);

    store.recordIntent('codex', 'item2', false);
    store.save();

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(saved.version).toBe(1);
    expect(saved.customKey).toBe('preservedValue');
    expect(saved.metadata).toEqual({ author: 'test' });
    expect(saved.intents.codex.item2).toBe(false);
  });

  it('drops corrupt or invalid profile entries with a warning and never throws', () => {
    const filePath = path.join(tmpDir, 'corrupt-profiles.json');
    const diskPayload = {
      version: 1,
      profiles: [
        {
          id: 'valid-1',
          name: 'Valid profile',
          createdAt: 1700000000000,
          providers: { codex: { knownItemIds: ['a'], disabledItemIds: [] } },
        },
        {
          id: '', // invalid: empty id
          name: 'Bad id',
          createdAt: 1700000000000,
          providers: {},
        },
        {
          id: 'bad-2',
          name: '', // invalid: empty name
          createdAt: 1700000000000,
          providers: {},
        },
        {
          id: 'bad-3',
          name: 'A'.repeat(41), // invalid: > 40 chars
          createdAt: 1700000000000,
          providers: {},
        },
        {
          id: 'bad-4',
          name: 'Invalid provider',
          createdAt: 1700000000000,
          providers: { unknownProvider: { knownItemIds: [], disabledItemIds: [] } },
        },
        null,
        'not-an-object',
      ],
    };
    fs.writeFileSync(filePath, JSON.stringify(diskPayload), 'utf8');

    const store = new SurfacesStore(filePath);
    expect(() => store.load()).not.toThrow();

    expect(store.profiles.list()).toHaveLength(1);
    expect(store.profiles.list()[0].id).toBe('valid-1');
    expect(store.warnings.some((w) => w.includes('Dropping corrupt or invalid profile entry'))).toBe(true);
  });

  it('enforces 50 profile limit on add and load', () => {
    const filePath = path.join(tmpDir, 'limit.json');
    const store = new SurfacesStore(filePath);

    for (let i = 0; i < 50; i++) {
      store.profiles.add({
        id: `prof-${i}`,
        name: `Profile ${i}`,
        createdAt: 1700000000000 + i,
        providers: {},
      });
    }

    expect(store.profiles.list()).toHaveLength(50);
    expect(() =>
      store.profiles.add({
        id: 'prof-50',
        name: 'Profile 50',
        createdAt: 1700000000050,
        providers: {},
      }),
    ).toThrow('Maximum number of profiles (50) reached');

    store.save();

    // Now test load with > 50 entries on disk
    const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    disk.profiles.push({
      id: 'prof-extra',
      name: 'Extra Profile',
      createdAt: 1700000000099,
      providers: {},
    });
    fs.writeFileSync(filePath, JSON.stringify(disk), 'utf8');

    const store2 = new SurfacesStore(filePath);
    store2.load();
    expect(store2.profiles.list()).toHaveLength(50);
    expect(store2.warnings.some((w) => w.includes('Profile limit exceeded'))).toBe(true);
  });

  describe('concurrent save merge (Finding 4)', () => {
    it('merges mutations when A saves then B saves', () => {
      const filePath = path.join(tmpDir, 'merge-ab.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: 1, unknownField: 'preserved-value' }, null, 2),
        'utf8',
      );

      const storeA = new SurfacesStore(filePath);
      storeA.load();

      const storeB = new SurfacesStore(filePath);
      storeB.load();

      storeA.removedHooks.add('claude', {
        id: 'hook-from-a',
        definition: { cmd: 'test' },
        originPath: '/path/to/hook',
      });

      storeB.profiles.add({
        id: 'prof-from-b',
        name: 'Profile from B',
        createdAt: 1700000000000,
        providers: {},
      });

      // A saves first, then B saves
      storeA.save();
      storeB.save();

      const merged = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(merged.version).toBe(1);
      expect(merged.unknownField).toBe('preserved-value');
      expect(merged.removedHooks?.claude).toHaveLength(1);
      expect(merged.removedHooks.claude[0].id).toBe('hook-from-a');
      expect(merged.profiles).toHaveLength(1);
      expect(merged.profiles[0].id).toBe('prof-from-b');
    });

    it('merges mutations when B saves then A saves', () => {
      const filePath = path.join(tmpDir, 'merge-ba.json');
      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: 1, customData: 42 }, null, 2),
        'utf8',
      );

      const storeA = new SurfacesStore(filePath);
      storeA.load();

      const storeB = new SurfacesStore(filePath);
      storeB.load();

      storeA.removedHooks.add('claude', {
        id: 'hook-from-a',
        definition: { cmd: 'test' },
      });

      storeB.profiles.add({
        id: 'prof-from-b',
        name: 'Profile from B',
        createdAt: 1700000000000,
        providers: {},
      });

      // B saves first, then A saves
      storeB.save();
      storeA.save();

      const merged = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(merged.version).toBe(1);
      expect(merged.customData).toBe(42);
      expect(merged.removedHooks?.claude).toHaveLength(1);
      expect(merged.removedHooks.claude[0].id).toBe('hook-from-a');
      expect(merged.profiles).toHaveLength(1);
      expect(merged.profiles[0].id).toBe('prof-from-b');
    });
  });

  describe('save refusal on newer version (Finding 5)', () => {
    it('throws when newer version appears on disk before save', () => {
      const filePath = path.join(tmpDir, 'concurrent-version.json');
      fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), 'utf8');

      const store = new SurfacesStore(filePath);
      store.load();
      store.recordIntent('claude', 'some-item', true);

      // Another process or writer updates the disk file to version 2
      fs.writeFileSync(filePath, JSON.stringify({ version: 2, newFeature: true }), 'utf8');

      expect(() => store.save()).toThrow(/refusing to save.*newer version 2/i);
      expect(store.warnings.some((w) => w.includes('Refusing to save'))).toBe(true);

      // Verify file on disk was not overwritten
      const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(disk.version).toBe(2);
      expect(disk.newFeature).toBe(true);
    });
  });

  describe('save refusal on unreadable, corrupt, or transient read error (D2-fix2 finding 1)', () => {
    it('refuses save when file exists but cannot be read (injected reader throws)', () => {
      const filePath = path.join(tmpDir, 'unreadable-injected.json');
      fs.writeFileSync(filePath, '{"version":1,"intents":{"claude":{"original":true}}}', 'utf8');

      const store = new SurfacesStore(filePath, {
        readFile: () => {
          throw new Error('EACCES: permission denied');
        },
      });

      store.recordIntent('claude', 'new-intent', false);
      expect(() => store.save()).toThrow(/refusing to save.*cannot read existing store file/i);
      expect(store.warnings.some((w) => w.includes('Refusing to save'))).toBe(true);

      // Verify original bytes on disk untouched
      expect(fs.readFileSync(filePath, 'utf8')).toBe(
        '{"version":1,"intents":{"claude":{"original":true}}}',
      );
    });

    it('refuses save when a directory is in place of the file', () => {
      const dirPath = path.join(tmpDir, 'dir-as-file.json');
      fs.mkdirSync(dirPath);

      const store = new SurfacesStore(dirPath);
      store.recordIntent('claude', 'some-intent', true);

      expect(() => store.save()).toThrow(/refusing to save.*cannot read existing store file/i);
      expect(store.warnings.some((w) => w.includes('Refusing to save'))).toBe(true);
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    });

    it('refuses save when file is corrupt, leaving bytes untouched, unless replaceCorrupt is true', () => {
      const filePath = path.join(tmpDir, 'corrupt-file.json');
      const corruptContent = '{\n"version": 1, invalid json here!!';
      fs.writeFileSync(filePath, corruptContent, 'utf8');

      const store = new SurfacesStore(filePath);
      // First load produces warning and empty in-memory store
      store.load();
      expect(store.warnings.some((w) => w.includes('Corrupt surfaces store'))).toBe(true);
      expect(store.getIntent('claude', 'test')).toBeUndefined();

      // Attempting to save without replaceCorrupt refuses and keeps bytes untouched
      store.recordIntent('claude', 'new-intent', true);
      expect(() => store.save()).toThrow(/refusing to save.*corrupt surfaces store file/i);
      expect(store.warnings.some((w) => w.includes('Refusing to save'))).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(corruptContent);

      // Explicitly passing replaceCorrupt: true allows overwrite
      expect(() => store.save({ replaceCorrupt: true })).not.toThrow();
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(saved.version).toBe(1);
      expect(saved.intents.claude['new-intent']).toBe(true);
    });

    it('refuses save on a transient read error, preserving bytes, and succeeds when error clears', () => {
      const filePath = path.join(tmpDir, 'transient-error.json');
      const originalPayload = { version: 1, intents: { codex: { featureA: true } } };
      fs.writeFileSync(filePath, JSON.stringify(originalPayload, null, 2), 'utf8');

      let failRead = false;
      const store = new SurfacesStore(filePath, {
        readFile: (p, enc) => {
          if (failRead) {
            throw new Error('EBUSY: resource locked');
          }
          return fs.readFileSync(p, enc);
        },
      });

      store.load();
      expect(store.getIntent('codex', 'featureA')).toBe(true);
      store.recordIntent('codex', 'featureB', false);

      // Transient failure during save
      failRead = true;
      expect(() => store.save()).toThrow(/refusing to save.*cannot read existing store file/i);
      expect(store.warnings.some((w) => w.includes('Refusing to save'))).toBe(true);

      // Verify file on disk is untouched
      const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(disk.intents.codex.featureA).toBe(true);
      expect(disk.intents.codex.featureB).toBeUndefined();

      // Transient error clears, retry save succeeds
      failRead = false;
      expect(() => store.save()).not.toThrow();
      const diskUpdated = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(diskUpdated.intents.codex.featureA).toBe(true);
      expect(diskUpdated.intents.codex.featureB).toBe(false);
    });

    it('refuses save when file on disk has unsupported non-numeric or non-1 version', () => {
      const filePath = path.join(tmpDir, 'unsupported-version.json');
      fs.writeFileSync(filePath, JSON.stringify({ version: 0, intents: {} }), 'utf8');

      const store = new SurfacesStore(filePath);
      store.recordIntent('claude', 'some-item', true);

      expect(() => store.save()).toThrow(/refusing to save: unsupported surfaces store version: 0/i);
      expect(store.warnings.some((w) => w.includes('Refusing to save'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).version).toBe(0);
    });
  });

  describe('name uniqueness on concurrent profile save replay (D2-fix2 finding 2)', () => {
    it('fails when two instances load before either saves and both add a profile with the same name', () => {
      const filePath = path.join(tmpDir, 'concurrent-name-uniqueness.json');
      fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), 'utf8');

      const storeA = new SurfacesStore(filePath);
      storeA.load();

      const storeB = new SurfacesStore(filePath);
      storeB.load();

      storeA.saveProfile({
        id: 'prof-id-1',
        name: 'Backend Profile',
        createdAt: 1000,
        providers: {},
      });

      storeB.saveProfile({
        id: 'prof-id-2',
        name: 'backend profile', // case-insensitive match, different id
        createdAt: 2000,
        providers: {},
      });

      // Instance A saves first successfully
      storeA.save();

      // Instance B saves second -> must fail with the same uniqueness error the in-memory API raises
      expect(() => storeB.save()).toThrow('A profile with this name already exists');
      expect(storeB.warnings).toContain('A profile with this name already exists');

      // Verify on disk: first profile remains intact and second was NOT saved
      const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(disk.profiles).toHaveLength(1);
      expect(disk.profiles[0].id).toBe('prof-id-1');
      expect(disk.profiles[0].name).toBe('Backend Profile');
    });

    it('allows replaying the same id (idempotent re-save)', () => {
      const filePath = path.join(tmpDir, 'idempotent-resave.json');
      fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), 'utf8');

      const store = new SurfacesStore(filePath);
      store.load();

      store.saveProfile({
        id: 'prof-same-id',
        name: 'Full Profile',
        createdAt: 1000,
        providers: { claude: { knownItemIds: ['a'], disabledItemIds: [] } },
      });
      store.save();

      // Re-save with updated data for the SAME id
      store.saveProfile({
        id: 'prof-same-id',
        name: 'Full Profile',
        createdAt: 1000,
        providers: { claude: { knownItemIds: ['a', 'b'], disabledItemIds: ['b'] } },
      });
      expect(() => store.save()).not.toThrow();

      const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(disk.profiles).toHaveLength(1);
      expect(disk.profiles[0].id).toBe('prof-same-id');
      expect(disk.profiles[0].providers.claude.knownItemIds).toEqual(['a', 'b']);
      expect(disk.profiles[0].providers.claude.disabledItemIds).toEqual(['b']);
    });
  });
});

