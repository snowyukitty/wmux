import * as fs from 'fs';
import type { TranscriptScanDeps, TranscriptScanResult } from './types';
import { findRecentJsonlFiles, BoundedLineReader, type DiscoveredFile } from './fileUtils';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_MESSAGES = 500;

export async function scanClaudeTranscripts(
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
    seenMessageIds: new Set<string>(),
    activeFileMessages: new Map<string, number>(),
  };

  const buildResult = (): TranscriptScanResult => {
    const allTokens = [...state.collectedTokens];
    for (const [msgId, tokens] of state.activeFileMessages) {
      if (!state.seenMessageIds.has(msgId)) {
        allTokens.push(tokens);
      }
    }
    const sampleSize = allTokens.length;
    const average =
      sampleSize > 0
        ? Math.round(allTokens.reduce((sum, val) => sum + val, 0) / sampleSize)
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

      state.activeFileMessages.clear();
      let stream: any = null;

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
            obj.type === 'assistant' &&
            obj.message &&
            typeof obj.message === 'object'
          ) {
            const msg = obj.message;
            const msgId = msg.id;
            if (typeof msgId === 'string' && msg.usage && typeof msg.usage === 'object') {
              const usage = msg.usage;
              const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
              const cacheCreation =
                typeof usage.cache_creation_input_tokens === 'number'
                  ? usage.cache_creation_input_tokens
                  : 0;
              const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

              if (
                !state.activeFileMessages.has(msgId) &&
                state.collectedTokens.length + state.activeFileMessages.size >= MAX_MESSAGES
              ) {
                break;
              }

              state.activeFileMessages.set(msgId, input + cacheCreation + output);
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

      for (const [msgId, tokens] of state.activeFileMessages) {
        if (!state.seenMessageIds.has(msgId)) {
          state.seenMessageIds.add(msgId);
          state.collectedTokens.push(tokens);
          if (state.collectedTokens.length >= MAX_MESSAGES) {
            break;
          }
        }
      }
      state.activeFileMessages.clear();
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
