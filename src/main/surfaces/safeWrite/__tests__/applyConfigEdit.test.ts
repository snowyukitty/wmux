import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyConfigEdit } from '../applyConfigEdit';
import { snapshotFile, ConfigChangedError } from '../snapshot';

describe('applyConfigEdit orchestrator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-orch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-op writes nothing and makes no backup', () => {
    const file = path.join(tmpDir, 'settings.json');
    const content = '{\n  "key": "value"\n}\n';
    fs.writeFileSync(file, content, 'utf8');

    const result = applyConfigEdit({
      path: file,
      kind: 'json',
      edits: [{ path: ['key'], op: 'set', value: 'value' }],
    });

    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    const files = fs.readdirSync(tmpDir);
    expect(files.filter((f) => f.includes('.bak-wmux-'))).toHaveLength(0);
  });

  it('change creates a backup and writes atomically', () => {
    const file = path.join(tmpDir, 'settings.json');
    const original = '{\n  "key": "value"\n}\n';
    fs.writeFileSync(file, original, 'utf8');

    const result = applyConfigEdit({
      path: file,
      kind: 'json',
      edits: [{ path: ['key'], op: 'set', value: 'newValue' }],
      now: new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeDefined();
    expect(fs.readFileSync(result.backupPath!, 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ key: 'newValue' });

    // No .tmp files left
    const files = fs.readdirSync(tmpDir);
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });

  it('concurrent modification between snapshot and write raises ConfigChangedError and leaves file untouched', () => {
    const file = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(file, 'enabled = true\n', 'utf8');

    const snap = snapshotFile(file);

    // Another process concurrently modifies the file
    fs.writeFileSync(file, 'enabled = false\n# external edit\n', 'utf8');

    expect(() =>
      applyConfigEdit({
        path: file,
        kind: 'toml',
        snapshot: snap,
        edits: [{ key: 'timeout', op: 'set', value: 1000 }],
      }),
    ).toThrow(ConfigChangedError);

    // File must keep the external edit untouched
    expect(fs.readFileSync(file, 'utf8')).toBe('enabled = false\n# external edit\n');
  });

  it('creates missing file when only set edits are provided (no backup needed)', () => {
    const file = path.join(tmpDir, 'brand-new.json');
    expect(fs.existsSync(file)).toBe(false);

    const result = applyConfigEdit({
      path: file,
      kind: 'json',
      edits: [{ path: ['created'], op: 'set', value: true }],
    });

    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ created: true });
  });

  it('treats delete edits on a missing file as no-ops', () => {
    const file = path.join(tmpDir, 'missing.json');

    const result = applyConfigEdit({
      path: file,
      kind: 'json',
      edits: [{ path: ['foo'], op: 'delete' }],
    });

    expect(result.changed).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('restores original file from backup when post-write verify fails', () => {
    const file = path.join(tmpDir, 'broken-verify.json');
    const original = '{\n  "safe": true\n}\n';
    fs.writeFileSync(file, original, 'utf8');

    // Spy on JSON.parse: allow initial parse, throw during post-write verify
    const realParse = JSON.parse;
    let parseCalls = 0;
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      parseCalls++;
      // Calls 1 and 2 happen during editJsonKeys
      if (parseCalls > 2) {
        throw new Error('Simulated post-write verify corruption');
      }
      return realParse(text as string, reviver);
    });

    try {
      expect(() =>
        applyConfigEdit({
          path: file,
          kind: 'json',
          edits: [{ path: ['safe'], op: 'set', value: false }],
        }),
      ).toThrow('Simulated post-write verify corruption');

      // The file on disk must have been restored to its original content
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('restores original file when post-write verify fails with backup:false', () => {
    const file = path.join(tmpDir, 'broken-verify-nobackup.json');
    const original = '{\n  "safe": true,\n  "count": 42\n}\n';
    fs.writeFileSync(file, original, 'utf8');

    const realParse = JSON.parse;
    let parseCalls = 0;
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      parseCalls++;
      // Calls 1 and 2 happen during editJsonKeys
      if (parseCalls > 2) {
        throw new Error('Simulated post-write verify corruption');
      }
      return realParse(text as string, reviver);
    });

    try {
      expect(() =>
        applyConfigEdit({
          path: file,
          kind: 'json',
          backup: false,
          edits: [{ path: ['safe'], op: 'set', value: false }],
        }),
      ).toThrow('Simulated post-write verify corruption');

      // The file on disk must end byte-identical to the original
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
      // No backup was created
      const files = fs.readdirSync(tmpDir);
      expect(files.filter((f) => f.includes('.bak-wmux-'))).toHaveLength(0);
    } finally {
      parseSpy.mockRestore();
    }
  });
});


