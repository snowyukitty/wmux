import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import {
  scanClaudeTranscripts,
  scanCodexTranscripts,
  BoundedLineReader,
  findRecentJsonlFiles,
} from '../index';

describe('Transcript scanners (Claude and Codex)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-transcript-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Claude transcripts', () => {
    it('counts duplicate message.id once and takes the last usage seen', async () => {
      const projDir = path.join(tmpDir, 'project-a');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionFile = path.join(projDir, 'session1.jsonl');

      // Lines for msg_1: first partial usage 10+5=15, then final usage 10+25=35
      // Line for msg_2: usage 50+30=80
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_1',
            usage: { input_tokens: 10, output_tokens: 25 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_2',
            usage: { input_tokens: 50, output_tokens: 30 },
          },
        }),
      ];
      fs.writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf8');

      const res = await scanClaudeTranscripts(tmpDir);
      // msg_1 last usage: 35, msg_2: 80. Mean = (35 + 80) / 2 = 57.5 -> rounded 58
      expect(res.sampleSize).toBe(2);
      expect(res.average).toBe(58);
      expect(res.partial).toBe(false);
    });

    it('includes cache_creation_input_tokens and excludes cache reads (cache_read_input_tokens) from tokens calculation', async () => {
      const projDir = path.join(tmpDir, 'proj');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionFile = path.join(projDir, 'session.jsonl');

      const line = JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_cache',
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 10000,
            output_tokens: 50,
          },
        },
      });
      fs.writeFileSync(sessionFile, line + '\n', 'utf8');

      const res = await scanClaudeTranscripts(tmpDir);
      // 100 input + 50 cache_creation + 50 output = 200 (10000 cache read excluded)
      expect(res.sampleSize).toBe(1);
      expect(res.average).toBe(200);
      expect(res.partial).toBe(false);
    });

    it('skips non-assistant line types (user, attachment, system, tool)', async () => {
      const projDir = path.join(tmpDir, 'proj');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionFile = path.join(projDir, 'session.jsonl');

      const lines = [
        JSON.stringify({ type: 'user', content: 'hello' }),
        JSON.stringify({ type: 'system', message: 'init' }),
        JSON.stringify({ type: 'attachment', data: 'xyz' }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_valid',
            usage: { input_tokens: 200, output_tokens: 100 },
          },
        }),
      ];
      fs.writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf8');

      const res = await scanClaudeTranscripts(tmpDir);
      expect(res.sampleSize).toBe(1);
      expect(res.average).toBe(300);
    });

    it('skips lines failing JSON.parse and oversize lines > 1 MB', async () => {
      const projDir = path.join(tmpDir, 'proj');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionFile = path.join(projDir, 'session.jsonl');

      const hugePadding = 'x'.repeat(1024 * 1024 + 50);
      const lines = [
        '{malformed JSON line',
        JSON.stringify({
          type: 'assistant',
          message: { id: 'msg_huge', usage: { input_tokens: 9999, output_tokens: 9999 } },
          pad: hugePadding,
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_ok',
            usage: { input_tokens: 40, output_tokens: 60 },
          },
        }),
      ];
      fs.writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf8');

      const res = await scanClaudeTranscripts(tmpDir);
      expect(res.sampleSize).toBe(1);
      expect(res.average).toBe(100);
    });

    it('discards lines exceeding 1 MB without buffering them whole and counts following lines', async () => {
      const projDir = path.join(tmpDir, 'proj-huge');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionFile = path.join(projDir, 'huge_line.jsonl');

      // 5 MB line without newlines, followed by \n, then a valid assistant line
      const fiveMbChunk = 'a'.repeat(5 * 1024 * 1024);
      const validLine = JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_after_huge',
          usage: { input_tokens: 150, output_tokens: 50 },
        },
      });

      fs.writeFileSync(sessionFile, fiveMbChunk + '\n' + validLine + '\n', 'utf8');

      // Directly test BoundedLineReader memory bounding
      const stream = fs.createReadStream(sessionFile);
      const reader = new BoundedLineReader(1024 * 1024);
      const lines: string[] = [];
      for await (const line of reader.readLines(stream)) {
        lines.push(line);
      }

      // Memory-bounded assertion: max buffered length never exceeded 1 MB
      expect(reader.maxBufferedBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(reader.maxBufferedLength).toBeLessThanOrEqual(1024 * 1024);
      // The 5 MB line was discarded
      expect(lines.length).toBe(1);
      expect(lines[0]).toBe(validLine);

      // And Claude scanner counts the following line
      const res = await scanClaudeTranscripts(tmpDir);
      expect(res.sampleSize).toBe(1);
      expect(res.average).toBe(200);
    });

    it('respects file bounds (at most 20 files, newest first)', async () => {
      const projDir = path.join(tmpDir, 'proj');
      fs.mkdirSync(projDir, { recursive: true });

      const now = 1760000000000;
      // Create 25 files with timestamps from now down to now - 24 hours
      for (let i = 0; i < 25; i++) {
        const file = path.join(projDir, `session_${String(i).padStart(2, '0')}.jsonl`);
        const content =
          JSON.stringify({
            type: 'assistant',
            message: { id: `msg_f${i}`, usage: { input_tokens: 10, output_tokens: 10 } },
          }) + '\n';
        fs.writeFileSync(file, content, 'utf8');
        // mtime: i=0 is newest, i=24 is oldest
        const mtime = new Date(now - i * 3600 * 1000);
        fs.utimesSync(file, mtime, mtime);
      }

      const res = await scanClaudeTranscripts(tmpDir, { now: () => now });
      expect(res.sampleSize).toBe(20);
      expect(res.average).toBe(20);
    });

    it('ignores files older than 7 days', async () => {
      const projDir = path.join(tmpDir, 'proj');
      fs.mkdirSync(projDir, { recursive: true });

      const now = 1760000000000;
      const recentFile = path.join(projDir, 'recent.jsonl');
      const oldFile = path.join(projDir, 'old.jsonl');

      fs.writeFileSync(
        recentFile,
        JSON.stringify({
          type: 'assistant',
          message: { id: 'msg_recent', usage: { input_tokens: 50, output_tokens: 50 } },
        }) + '\n',
        'utf8',
      );
      const recentMtime = new Date(now - 2 * 24 * 3600 * 1000);
      fs.utimesSync(recentFile, recentMtime, recentMtime);

      fs.writeFileSync(
        oldFile,
        JSON.stringify({
          type: 'assistant',
          message: { id: 'msg_old', usage: { input_tokens: 1000, output_tokens: 1000 } },
        }) + '\n',
        'utf8',
      );
      const oldMtime = new Date(now - 8 * 24 * 3600 * 1000);
      fs.utimesSync(oldFile, oldMtime, oldMtime);

      const res = await scanClaudeTranscripts(tmpDir, { now: () => now });
      expect(res.sampleSize).toBe(1);
      expect(res.average).toBe(100);
    });

    it('stops after 500 counted messages', async () => {
      const projDir = path.join(tmpDir, 'proj');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionFile = path.join(projDir, 'big_session.jsonl');

      const lines: string[] = [];
      for (let i = 0; i < 600; i++) {
        lines.push(
          JSON.stringify({
            type: 'assistant',
            message: { id: `msg_${i}`, usage: { input_tokens: 10, output_tokens: 20 } },
          }),
        );
      }
      fs.writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf8');

      const res = await scanClaudeTranscripts(tmpDir);
      expect(res.sampleSize).toBe(500);
      expect(res.average).toBe(30);
      expect(res.partial).toBe(false);
    });

    it('still scans eligible files already found and returns partial:true when file discovery hits time budget', async () => {
      const projDir = path.join(tmpDir, 'proj-disc-timeout');
      fs.mkdirSync(projDir, { recursive: true });

      const f1 = path.join(projDir, 's1.jsonl');
      const f2 = path.join(projDir, 's2.jsonl');

      fs.writeFileSync(
        f1,
        JSON.stringify({
          type: 'assistant',
          message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 100 } },
        }) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        f2,
        JSON.stringify({
          type: 'assistant',
          message: { id: 'm2', usage: { input_tokens: 200, output_tokens: 200 } },
        }) + '\n',
        'utf8',
      );

      // Discovery finds s1.jsonl and then hits budget before s2.jsonl
      let filesFound = 0;
      let timedOutAfterFile = false;
      const res = await scanClaudeTranscripts(tmpDir, {
        now: () => (timedOutAfterFile ? 5000 : 1000),
        budget: 500,
        stat: async (p) => {
          const st = await fs.promises.stat(p);
          if (p.endsWith('.jsonl')) {
            filesFound++;
            if (filesFound >= 1) {
              timedOutAfterFile = true;
            }
          }
          return st;
        },
      });

      // Must scan eligible files already discovered rather than returning empty result
      expect(res.partial).toBe(true);
      expect(res.sampleSize).toBeGreaterThan(0);
      expect(res.average).not.toBeNull();
    });

    it('resolves with partial when readdir never resolves without exceeding budget', async () => {
      const neverResolvingReaddir = () =>
        new Promise<string[]>(() => {
          // Never resolves
        });

      const start = Date.now();
      const res = await scanClaudeTranscripts(tmpDir, {
        readdir: neverResolvingReaddir,
        budget: 50,
      });
      const elapsed = Date.now() - start;

      expect(res.partial).toBe(true);
      expect(res.sampleSize).toBe(0);
      expect(res.average).toBeNull();
      expect(elapsed).toBeLessThan(1200);
    });

    it('preserves partial tokens collected so far when stalled filesystem call hits budget', async () => {
      const projDir = path.join(tmpDir, 'proj-stall-partial');
      fs.mkdirSync(projDir, { recursive: true });

      const f1 = path.join(projDir, 'session1.jsonl');
      fs.writeFileSync(
        f1,
        JSON.stringify({
          type: 'assistant',
          message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 50 } },
        }) + '\n',
        'utf8',
      );

      const f2 = path.join(projDir, 'session2.jsonl');
      fs.writeFileSync(f2, '{"dummy": true}\n', 'utf8');

      // Make f1 newer so it is guaranteed to be processed first
      const now = Date.now();
      fs.utimesSync(f1, new Date(now), new Date(now));
      fs.utimesSync(f2, new Date(now - 10000), new Date(now - 10000));

      let streamCount = 0;
      const customCreateStream = (p: string) => {
        streamCount++;
        if (streamCount === 1) {
          return fs.createReadStream(p);
        }
        // Second stream stalls indefinitely
        return new Readable({
          read() {},
        });
      };

      const res = await scanClaudeTranscripts(tmpDir, {
        createReadStream: customCreateStream,
        budget: 60,
      });

      expect(res.partial).toBe(true);
      expect(res.sampleSize).toBe(1);
      expect(res.average).toBe(150);
    });

    it('skips symlinks to outside directories and cycles without infinite loop', (ctx) => {
      const rootDir = path.join(tmpDir, 'discovery-root');
      const outsideDir = path.join(tmpDir, 'outside');
      fs.mkdirSync(rootDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      fs.writeFileSync(
        path.join(outsideDir, 'outside.jsonl'),
        JSON.stringify({
          type: 'assistant',
          message: { id: 'outside_msg', usage: { input_tokens: 999, output_tokens: 999 } },
        }) + '\n',
        'utf8',
      );

      fs.writeFileSync(
        path.join(rootDir, 'inside.jsonl'),
        JSON.stringify({
          type: 'assistant',
          message: { id: 'inside_msg', usage: { input_tokens: 100, output_tokens: 100 } },
        }) + '\n',
        'utf8',
      );

      const symlinkToOutside = path.join(rootDir, 'link_outside');
      const cycleDir = path.join(rootDir, 'sub');
      fs.mkdirSync(cycleDir, { recursive: true });
      const cycleLink = path.join(cycleDir, 'cycle_to_root');

      let symlinksCreated = false;
      try {
        fs.symlinkSync(outsideDir, symlinkToOutside, 'dir');
        fs.symlinkSync(rootDir, cycleLink, 'dir');
        symlinksCreated = true;
      } catch (err: any) {
        if (err?.code === 'EPERM' || err?.code === 'EACCES') {
          ctx.skip('Symlink creation not permitted on this machine (requires Windows Developer Mode or Admin)');
          return;
        }
        throw err;
      }

      expect(symlinksCreated).toBe(true);
      return scanClaudeTranscripts(rootDir).then((res) => {
        expect(res.sampleSize).toBe(1);
        expect(res.average).toBe(200);
      });
    });

    it('never follows symlinks during discovery using Dirent/lstat mocks', async () => {
      const mockReaddir = async (dirPath: string) => {
        if (dirPath.endsWith('discovery-test')) {
          return [
            {
              name: 'symlink-dir',
              isSymbolicLink: () => true,
              isDirectory: () => true,
              isFile: () => false,
            },
            {
              name: 'real-dir',
              isSymbolicLink: () => false,
              isDirectory: () => true,
              isFile: () => false,
            },
            {
              name: 'real.jsonl',
              isSymbolicLink: () => false,
              isDirectory: () => false,
              isFile: () => true,
            },
          ] as unknown as fs.Dirent[];
        }
        if (path.basename(dirPath) === 'real-dir') {
          return [
            {
              name: 'nested.jsonl',
              isSymbolicLink: () => false,
              isDirectory: () => false,
              isFile: () => true,
            },
          ] as unknown as fs.Dirent[];
        }
        return [] as fs.Dirent[];
      };

      const mockLstat = async (filePath: string) => {
        const base = path.basename(filePath);
        if (base === 'symlink-dir') {
          return {
            isFile: () => false,
            isDirectory: () => true,
            isSymbolicLink: () => true,
          };
        }
        if (base === 'real-dir') {
          return {
            isFile: () => false,
            isDirectory: () => true,
            isSymbolicLink: () => false,
          };
        }
        return {
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          mtimeMs: Date.now(),
        };
      };

      const result = await findRecentJsonlFiles(
        path.join(tmpDir, 'discovery-test'),
        { readdir: mockReaddir, lstat: mockLstat },
        Date.now(),
        1000,
      );

      const paths = result.files.map((f) => f.path);
      expect(paths.some((p) => p.includes('symlink-dir'))).toBe(false);
      expect(paths.some((p) => p.includes('real.jsonl'))).toBe(true);
      expect(paths.some((p) => p.includes('nested.jsonl'))).toBe(true);
    });

    it('enforces maximum traversal depth of 6 to prevent cycles', async () => {
      let visitedDepths = 0;
      const mockReaddir = async () => {
        visitedDepths++;
        return [
          {
            name: `next-level`,
            isSymbolicLink: () => false,
            isDirectory: () => true,
            isFile: () => false,
          },
        ] as unknown as fs.Dirent[];
      };
      const mockLstat = async () => ({
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      });

      await findRecentJsonlFiles(
        path.join(tmpDir, 'depth-root'),
        { readdir: mockReaddir, lstat: mockLstat },
        Date.now(),
        2000,
      );

      // Traversal starts at depth 0 and stops enqueuing after depth 6 (at most 7 readdir calls)
      expect(visitedDepths).toBeLessThanOrEqual(7);
    });

    it('has no content leaks (only average, sampleSize, partial)', async () => {
      const projDir = path.join(tmpDir, 'proj_secret_name');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionFile = path.join(projDir, 'session_secret_uuid.jsonl');

      fs.writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'secret_message_id_123',
            usage: { input_tokens: 100, output_tokens: 200 },
          },
          secretContent: 'super confidential transcript',
        }) + '\n',
        'utf8',
      );

      const res = await scanClaudeTranscripts(tmpDir);
      const keys = Object.keys(res).sort();
      expect(keys).toEqual(['average', 'partial', 'sampleSize']);
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain('secret');
      expect(serialized).not.toContain('confidential');
      expect(serialized).not.toContain('proj_secret_name');
    });

    it('returns average null and sampleSize 0 when directory does not exist', async () => {
      const nonExistent = path.join(tmpDir, 'does-not-exist');
      const res = await scanClaudeTranscripts(nonExistent);
      expect(res).toEqual({
        average: null,
        sampleSize: 0,
        partial: false,
      });
    });
  });

  describe('Codex transcripts', () => {
    it('dedupes consecutive token_count events whose total_tokens did not change', async () => {
      const sessionDir = path.join(tmpDir, 'nested', 'sessions');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'codex_session.jsonl');

      const lines = [
        // Event 1: tokens 100+50=150, total_tokens: 1000
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 100, output_tokens: 50 },
              total_token_usage: { total_tokens: 1000 },
            },
          },
        }),
        // Event 2: duplicate totals (1000) -> should be deduped
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 100, output_tokens: 50 },
              total_token_usage: { total_tokens: 1000 },
            },
          },
        }),
        // Unrelated event in between
        JSON.stringify({ type: 'other_event', payload: {} }),
        // Event 3: duplicate totals still 1000 -> should still be deduped
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 100, output_tokens: 50 },
              total_token_usage: { total_tokens: 1000 },
            },
          },
        }),
        // Event 4: total_tokens changed to 1800 -> counted!
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 200, output_tokens: 150 },
              total_token_usage: { total_tokens: 1800 },
            },
          },
        }),
      ];
      fs.writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf8');

      const res = await scanCodexTranscripts(tmpDir);
      // Event 1 (150) and Event 4 (350). Mean = (150 + 350) / 2 = 250
      expect(res.sampleSize).toBe(2);
      expect(res.average).toBe(250);
      expect(res.partial).toBe(false);
    });

    it('includes cache_write_input_tokens and excludes cached_input_tokens from token count', async () => {
      const sessionDir = path.join(tmpDir, 'sess');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'sess.jsonl');

      const line = JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 300,
              cached_input_tokens: 1200,
              cache_write_input_tokens: 100,
              output_tokens: 70,
              reasoning_output_tokens: 30,
              total_tokens: 1670,
            },
            total_token_usage: { total_tokens: 5000 },
          },
        },
      });
      fs.writeFileSync(sessionFile, line + '\n', 'utf8');

      const res = await scanCodexTranscripts(tmpDir);
      // input_tokens (300) + cache_write_input_tokens (100) + output_tokens (70) = 470
      // cached_input_tokens (1200) excluded
      expect(res.sampleSize).toBe(1);
      expect(res.average).toBe(470);
    });

    it('skips oversize lines (> 1 MB) and malformed lines', async () => {
      const sessionDir = path.join(tmpDir, 'sess');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'sess.jsonl');

      const huge = 'y'.repeat(1024 * 1024 + 100);
      const lines = [
        '{broken json line',
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } },
          },
          huge,
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 50, output_tokens: 50 },
              total_token_usage: { total_tokens: 100 },
            },
          },
        }),
      ];
      fs.writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf8');

      const res = await scanCodexTranscripts(tmpDir);
      expect(res.sampleSize).toBe(1);
      expect(res.average).toBe(100);
    });

    it('discards lines exceeding 1 MB without buffering whole and counts following Codex lines', async () => {
      const sessionDir = path.join(tmpDir, 'sess-huge');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'huge.jsonl');

      const fiveMbChunk = 'z'.repeat(5 * 1024 * 1024);
      const validLine = JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 60, output_tokens: 40 },
            total_token_usage: { total_tokens: 100 },
          },
        },
      });

      fs.writeFileSync(sessionFile, fiveMbChunk + '\n' + validLine + '\n', 'utf8');

      const res = await scanCodexTranscripts(tmpDir);
      expect(res.sampleSize).toBe(1);
      expect(res.average).toBe(100);
    });

    it('respects file bounds and stops after 500 counted messages', async () => {
      const sessionDir = path.join(tmpDir, 'sess');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'large.jsonl');

      const lines: string[] = [];
      for (let i = 0; i < 550; i++) {
        lines.push(
          JSON.stringify({
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: { input_tokens: 10, output_tokens: 10 },
                total_token_usage: { total_tokens: (i + 1) * 20 },
              },
            },
          }),
        );
      }
      fs.writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf8');

      const res = await scanCodexTranscripts(tmpDir);
      expect(res.sampleSize).toBe(500);
      expect(res.average).toBe(20);
      expect(res.partial).toBe(false);
    });

    it('still scans eligible files already found and returns partial:true when discovery hits time budget (Codex)', async () => {
      const sessionDir = path.join(tmpDir, 'sess-disc-timeout');
      fs.mkdirSync(sessionDir, { recursive: true });

      const f1 = path.join(sessionDir, 'sess1.jsonl');
      const f2 = path.join(sessionDir, 'sess2.jsonl');

      fs.writeFileSync(
        f1,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 50, output_tokens: 50 },
              total_token_usage: { total_tokens: 100 },
            },
          },
        }) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        f2,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 100, output_tokens: 100 },
              total_token_usage: { total_tokens: 300 },
            },
          },
        }) + '\n',
        'utf8',
      );

      let filesFound = 0;
      let timedOutAfterFile = false;
      const res = await scanCodexTranscripts(tmpDir, {
        now: () => (timedOutAfterFile ? 5000 : 1000),
        budget: 500,
        stat: async (p) => {
          const st = await fs.promises.stat(p);
          if (p.endsWith('.jsonl')) {
            filesFound++;
            if (filesFound >= 1) {
              timedOutAfterFile = true;
            }
          }
          return st;
        },
      });

      expect(res.partial).toBe(true);
      expect(res.sampleSize).toBeGreaterThan(0);
      expect(res.average).not.toBeNull();
    });

    it('resolves with partial when Codex filesystem call never resolves', async () => {
      const neverResolvingReaddir = () =>
        new Promise<string[]>(() => {
          // Never resolves
        });

      const start = Date.now();
      const res = await scanCodexTranscripts(tmpDir, {
        readdir: neverResolvingReaddir,
        budget: 50,
      });
      const elapsed = Date.now() - start;

      expect(res.partial).toBe(true);
      expect(res.sampleSize).toBe(0);
      expect(res.average).toBeNull();
      expect(elapsed).toBeLessThan(1200);
    });

    it('has no content leaks (only average, sampleSize, partial)', async () => {
      const sessionDir = path.join(tmpDir, 'codex_secret_folder');
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, 'secret_session.jsonl');

      fs.writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 50, output_tokens: 50 },
              total_token_usage: { total_tokens: 100 },
              secretPrompt: 'classified user prompt',
            },
          },
        }) + '\n',
        'utf8',
      );

      const res = await scanCodexTranscripts(tmpDir);
      expect(Object.keys(res).sort()).toEqual(['average', 'partial', 'sampleSize']);
      expect(JSON.stringify(res)).not.toContain('secretPrompt');
      expect(JSON.stringify(res)).not.toContain('classified');
    });

    it('returns partial on timeout', async () => {
      const sessionDir = path.join(tmpDir, 'sess');
      fs.mkdirSync(sessionDir, { recursive: true });

      const file = path.join(sessionDir, 'sess.jsonl');
      fs.writeFileSync(
        file,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 10, output_tokens: 10 },
              total_token_usage: { total_tokens: 20 },
            },
          },
        }) + '\n',
        'utf8',
      );

      let time = 1000;
      const res = await scanCodexTranscripts(tmpDir, {
        now: () => (time += 2000),
        budget: 50,
      });

      expect(res.partial).toBe(true);
    });
  });
});
