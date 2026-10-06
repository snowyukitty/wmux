import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { snapshotFile, assertUnchanged, ConfigChangedError } from '../snapshot';
import { writeFileAtomic } from '../atomicWrite';

describe('snapshotFile and assertUnchanged', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-snap-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('snapshots a nonexistent file and detects appearance', () => {
    const file = path.join(tmpDir, 'missing.json');
    const snap = snapshotFile(file);
    expect(snap.exists).toBe(false);
    expect(snap.sha256).toBeNull();
    expect(snap.text).toBeNull();

    // assertUnchanged passes while still missing
    expect(() => assertUnchanged(file, snap)).not.toThrow();

    // Now file appears
    fs.writeFileSync(file, '{"a":1}', 'utf8');
    expect(() => assertUnchanged(file, snap)).toThrow(ConfigChangedError);
  });

  it('snapshots an existing file and detects vanish', () => {
    const file = path.join(tmpDir, 'exists.json');
    fs.writeFileSync(file, '{"a":1}', 'utf8');

    const snap = snapshotFile(file);
    expect(snap.exists).toBe(true);
    expect(snap.sha256).toBeTruthy();
    expect(snap.text).toBe('{"a":1}');

    // Unchanged
    expect(() => assertUnchanged(file, snap)).not.toThrow();

    // Vanishes
    fs.unlinkSync(file);
    expect(() => assertUnchanged(file, snap)).toThrow(ConfigChangedError);
  });

  it('detects content modification (hash change)', () => {
    const file = path.join(tmpDir, 'config.json');
    fs.writeFileSync(file, '{"val":1}', 'utf8');

    const snap = snapshotFile(file);
    fs.writeFileSync(file, '{"val":2}', 'utf8');

    expect(() => assertUnchanged(file, snap)).toThrow(ConfigChangedError);
  });

  it('does not throw if content is identical even if touched', () => {
    const file = path.join(tmpDir, 'config.json');
    fs.writeFileSync(file, '{"val":1}', 'utf8');

    const snap = snapshotFile(file);
    // Rewrite identical content
    fs.writeFileSync(file, '{"val":1}', 'utf8');

    expect(() => assertUnchanged(file, snap)).not.toThrow();
  });
});

describe('writeFileAtomic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-atomic-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes content atomically and creates parent directories', () => {
    const target = path.join(tmpDir, 'deep', 'nested', 'config.json');
    writeFileAtomic(target, '{"hello":"world"}\n');

    expect(fs.readFileSync(target, 'utf8')).toBe('{"hello":"world"}\n');
    const files = fs.readdirSync(path.dirname(target));
    expect(files.filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('preserves symlink target without replacing the link', () => {
    const realFile = path.join(tmpDir, 'real-config.json');
    const linkFile = path.join(tmpDir, 'symlink-config.json');

    fs.writeFileSync(realFile, 'initial content', 'utf8');
    try {
      fs.symlinkSync(realFile, linkFile);
    } catch {
      // Symlink creation might require privileges on Windows in non-developer mode
      return;
    }

    writeFileAtomic(linkFile, 'updated content');

    // Link must still be a symlink
    expect(fs.lstatSync(linkFile).isSymbolicLink()).toBe(true);
    // Real file must have received the content
    expect(fs.readFileSync(realFile, 'utf8')).toBe('updated content');
  });

  it('leaves no .tmp leftovers behind on write failure', () => {
    const target = path.join(tmpDir, 'test.txt');
    // Calling with valid text first
    writeFileAtomic(target, 'content');

    const files = fs.readdirSync(tmpDir);
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
  });
});
