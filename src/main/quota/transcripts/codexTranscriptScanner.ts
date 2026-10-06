import * as fs from 'fs';
import type { TranscriptScanDeps, TranscriptScanResult } from './types';
import { findRecentJsonlFiles, BoundedLineReader, type DiscoveredFile } from './fileUtils';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_MESSAGES = 500;

export async function scanCodexTranscripts(
  dir: string,
  deps: TranscriptScanDeps = {},
): Promise<TranscriptScanResult> {
  const nowFn = deps.now ?? Date.now;
  const budget = deps.budget ?? deps.budgetMs ?? 1500;
  const startTime = nowFn();

  const state = {
    collectedTokens: [] as number[],
    partial: false,
    done: false,
  };

  const buildResult = (): TranscriptScanResult => {
    const sampleSize = state.collectedTokens.length;
    const average =
      sampleSize > 0
        ? Math.round(state.collectedTokens.reduce((sum, val) => sum + val, 0) / sampleSize)
        : null;
    return {
      average,
      sampleSize,
      partial: state.partial,
    };
  };

  let timerId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<TranscriptScanResult>((resolve) => {
    timerId = setTimeout(() => {
      state.partial = true;
      state.done = true;
      resolve(buildResult());
    }, Math.max(0, budget));
  });

  const runScan = async (): Promise<TranscriptScanResult> => {
    let files: DiscoveredFile[] = [];
    try {
      const discovery = await findRecentJsonlFiles(dir, deps, startTime, budget);
      files = discovery.files;
      if (discovery.timedOut) {
        state.partial = true;
      }
    } catch {
      return {
        average: null,
        sampleSize: 0,
        partial: false,
      };
    }

    if (state.done) {
      return buildResult();
    }

    const createStreamFn = deps.createReadStream ?? fs.createReadStream;

    for (const file of files) {
      if (state.done || state.collectedTokens.length >= MAX_MESSAGES) {
        break;
      }

      let stream: any = null;
      let prevTotalTokens: number | null = null;

      try {
        stream = createStreamFn(file.path);
        const reader = new BoundedLineReader(MAX_LINE_BYTES);

        for await (const line of reader.readLines(stream)) {
          if (state.done) {
            break;
          }

          if (line.length > MAX_LINE_BYTES || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
            continue;
          }

          let obj: any;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }

          if (
            obj &&
            typeof obj === 'object' &&
            obj.type === 'event_msg' &&
            obj.payload &&
            typeof obj.payload === 'object' &&
            obj.payload.type === 'token_count' &&
            obj.payload.info &&
            typeof obj.payload.info === 'object'
          ) {
            const info = obj.payload.info;
            const last = info.last_token_usage;
            if (!last || typeof last !== 'object') continue;

            const totalUsage = info.total_token_usage;
            const totalTokens =
              totalUsage && typeof totalUsage.total_tokens === 'number'
                ? totalUsage.total_tokens
                : null;

            if (
              prevTotalTokens !== null &&
              totalTokens !== null &&
              totalTokens === prevTotalTokens
            ) {
              continue;
            }

            if (totalTokens !== null) {
              prevTotalTokens = totalTokens;
            }

            const input = typeof last.input_tokens === 'number' ? last.input_tokens : 0;
            const cacheWrite =
              typeof last.cache_write_input_tokens === 'number'
                ? last.cache_write_input_tokens
                : 0;
            const output = typeof last.output_tokens === 'number' ? last.output_tokens : 0;

            state.collectedTokens.push(input + cacheWrite + output);
            if (state.collectedTokens.length >= MAX_MESSAGES) {
              break;
            }
          }
        }
      } catch {
        // Ignore file read failure
      } finally {
        if (stream && typeof stream.destroy === 'function') {
          stream.destroy();
        }
      }
    }

    return buildResult();
  };

  try {
    return await Promise.race([runScan(), timeoutPromise]);
  } finally {
    if (timerId !== null) {
      clearTimeout(timerId);
    }
  }
}
