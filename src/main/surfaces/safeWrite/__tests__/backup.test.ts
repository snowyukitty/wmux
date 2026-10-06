import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { backupFile } from '../backup';

describe('backupFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-backup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates backup with filesystem-safe ISO-ish timestamp and no colons', () => {
    const file = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(file, 'original content', 'utf8');

    const backupPath = backupFile(file, new Date('2026-09-30T12:00:00.000Z'));
    expect(path.basename(backupPath)).not.toContain(':');
    expect(backupPath).toContain('settings.json.bak-wmux-2026-09-30T12-00-00.000Z');
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('original content');
  });

  it('prunes oldest backups keeping at most default 5', () => {
    const file = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(file, 'v1', 'utf8');

    const times = [
      new Date('2026-09-30T10:00:00.000Z'),
      new Date('2026-09-30T11:00:00.000Z'),
      new Date('2026-09-30T12:00:00.000Z'),
      new Date('2026-09-30T13:00:00.000Z'),
      new Date('2026-09-30T14:00:00.000Z'),
      new Date('2026-09-30T15:00:00.000Z'),
      new Date('2026-09-30T16:00:00.000Z'),
    ];

    for (let i = 0; i < times.length; i++) {
      fs.writeFileSync(file, `v${i + 1}`, 'utf8');
      backupFile(file, times[i]);
    }

    const allFiles = fs.readdirSync(tmpDir);
    const backups = allFiles.filter((f) => f.startsWith('config.toml.bak-wmux-'));
    expect(backups).toHaveLength(5);

    // Oldest two (10:00 and 11:00) should have been pruned
    expect(backups.some((f) => f.includes('10-00-00'))).toBe(false);
    expect(backups.some((f) => f.includes('11-00-00'))).toBe(false);

    // 5 newest (12:00 through 16:00) should be present
    expect(backups.some((f) => f.includes('12-00-00'))).toBe(true);
    expect(backups.some((f) => f.includes('16-00-00'))).toBe(true);
  });

  it('never deletes unrelated files or backups of other files in the same dir', () => {
    const fileA = path.join(tmpDir, 'fileA.json');
    const fileB = path.join(tmpDir, 'fileB.json');
    const unrelated = path.join(tmpDir, 'fileA.json.bak-custom-manual');

    fs.writeFileSync(fileA, 'A', 'utf8');
    fs.writeFileSync(fileB, 'B', 'utf8');
    fs.writeFileSync(unrelated, 'manual backup', 'utf8');

    // Create 6 backups of fileA
    for (let i = 1; i <= 6; i++) {
      backupFile(fileA, new Date(`2026-09-30T1${i}:00:00.000Z`));
    }

    // Also create 1 backup of fileB
    const fileBBackup = backupFile(fileB, new Date('2026-09-30T10:00:00.000Z'));

    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(fileBBackup)).toBe(true);

    const aBackups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('fileA.json.bak-wmux-'));
    expect(aBackups).toHaveLength(5);
  });

  it('prunes only exact writer backups, preserving names like .bak-wmux-notes and .bak-wmux-', () => {
    const file = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(file, 'v0', 'utf8');

    const notesFile = path.join(tmpDir, 'config.toml.bak-wmux-notes');
    const emptySuffixFile = path.join(tmpDir, 'config.toml.bak-wmux-');
    fs.writeFileSync(notesFile, 'notes content', 'utf8');
    fs.writeFileSync(emptySuffixFile, 'empty suffix content', 'utf8');

    // Create 7 valid backups (exceeding default limit of 5)
    for (let i = 1; i <= 7; i++) {
      fs.writeFileSync(file, `v${i}`, 'utf8');
      backupFile(file, new Date(`2026-09-30T1${i}:00:00.000Z`));
    }

    // Non-conforming files such as config.toml.bak-wmux-notes and config.toml.bak-wmux- must survive pruning
    expect(fs.existsSync(notesFile)).toBe(true);
    expect(fs.readFileSync(notesFile, 'utf8')).toBe('notes content');
    expect(fs.existsSync(emptySuffixFile)).toBe(true);
    expect(fs.readFileSync(emptySuffixFile, 'utf8')).toBe('empty suffix content');

    // Only 5 valid backups should remain
    const backups = fs.readdirSync(tmpDir).filter((f) =>
      /^config\.toml\.bak-wmux-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:-\d+)?$/.test(f),
    );
    expect(backups).toHaveLength(5);
  });
});

