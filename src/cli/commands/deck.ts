/**
 * `wmux deck state [--orphans] [--prune --yes] [--json]`
 *
 * Command Deck maintenance CLI:
 *   - `wmux deck state --orphans`: reports orphan Deck state across store files (read-only).
 *   - `wmux deck state --prune --yes`: cleans orphan state and archives active work records.
 *
 * Invariants:
 *   - Fail-closed: if the live workspace list cannot be retrieved from wmux
 *     (unreachable, error response, or empty list), refuses to touch anything.
 *   - Read-only orphans mode: --orphans never modifies or writes any file.
 *   - Confirmation safety: --prune refuses without --yes.
 *   - Zero Electron dependencies: must remain cleanly importable into CLI bundle.
 */

import path from 'node:path';
import type { RpcResponse } from '../../shared/rpc';
import { sendRequest } from '../client';
import { getWmuxDir } from '../../daemon/config';
import {
  collectDeckWorkspaceFiles,
  reconcileOrphanDeckState,
} from '../../main/deck/deckOrphanReconcile';
import { getDeckWorkArchivePath } from '../../main/deck/deckWorkStore';

export interface DeckConsole {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface DeckDeps {
  /**
   * Query the live workspace list via RPC ('workspace.list').
   */
  getWorkspaces: () => Promise<RpcResponse>;
  /**
   * Ask the running app to prune ('deck.state.prune'). The app owns the Deck
   * store files and their write locks, so the CLI never rewrites them itself.
   */
  pruneInApp: () => Promise<RpcResponse>;
  /**
   * Resolve wmux state directory.
   */
  getWmuxDir: () => string;
  /**
   * Timestamp provider.
   */
  now: () => number;
  /**
   * Console sink for logs and errors.
   */
  console: DeckConsole;
  /**
   * Process exit function.
   */
  exit: (code: number) => void;
}

export const DECK_USAGE = `Usage: wmux deck state [--orphans] [--prune --yes] [--json]

Report or prune orphan Command Deck state.

Commands:
  wmux deck state --orphans       List orphan workspace IDs across Deck store files
  wmux deck state --prune --yes   Prune orphan state (archives active work records)

Options:
  --orphans   List orphan workspace IDs and their containing Deck files (read-only)
  --prune     Prune orphan workspace state (requires --yes)
  --yes       Confirm pruning of orphan workspace state
  --json      Output result as JSON
`;

export function createDefaultDeckDeps(overrides?: Partial<DeckDeps>): DeckDeps {
  return {
    getWorkspaces: () => sendRequest('workspace.list', {}),
    pruneInApp: () => sendRequest('deck.state.prune', {}),
    getWmuxDir: () => getWmuxDir(),
    now: () => Date.now(),
    console: {
      log: (...args: unknown[]) => console.log(...args),
      error: (...args: unknown[]) => console.error(...args),
    },
    exit: (code: number) => process.exit(code),
    ...overrides,
  };
}

/**
 * Pure command executor over injected dependencies.
 * Returns the process exit code (0 on success, non-zero on error/refusal).
 */
export async function runDeck(
  args: string[],
  deps: DeckDeps,
  jsonMode = false,
): Promise<number> {
  const isJson = jsonMode || args.includes('--json');
  const cleanArgs = args.filter((a) => a !== '--json');
  const subcmd = cleanArgs[0];

  if (subcmd !== 'state') {
    deps.console.error(DECK_USAGE.trimEnd());
    deps.exit(1);
    return 1;
  }

  const subArgs = cleanArgs.slice(1);
  const orphansMode = subArgs.includes('--orphans');
  const pruneMode = subArgs.includes('--prune');
  const yesMode = subArgs.includes('--yes');

  if (!orphansMode && !pruneMode) {
    deps.console.error(DECK_USAGE.trimEnd());
    deps.exit(1);
    return 1;
  }

  if (pruneMode && !yesMode) {
    deps.console.error('deck state --prune requires --yes');
    deps.exit(1);
    return 1;
  }

  // Live workspace list: ask running app
  let liveIds: string[] = [];
  try {
    const resp = await deps.getWorkspaces();
    if (!resp || !resp.ok || !Array.isArray(resp.result) || resp.result.length === 0) {
      deps.console.error('deck state: cannot read the live workspace list (is wmux running?)');
      deps.exit(1);
      return 1;
    }
    const ids: string[] = [];
    for (const item of resp.result as Array<{ id?: unknown }>) {
      if (item && typeof item === 'object' && typeof item.id === 'string' && item.id.trim()) {
        ids.push(item.id.trim());
      }
    }
    if (ids.length === 0) {
      deps.console.error('deck state: cannot read the live workspace list (is wmux running?)');
      deps.exit(1);
      return 1;
    }
    liveIds = ids;
  } catch {
    deps.console.error('deck state: cannot read the live workspace list (is wmux running?)');
    deps.exit(1);
    return 1;
  }

  const dir = deps.getWmuxDir();
  const now = deps.now();

  if (pruneMode) {
    let archivePath: string;
    try {
      archivePath = getDeckWorkArchivePath(dir);
    } catch {
      archivePath = path.join(dir, 'deck-work.archive.json');
    }

    let pruneReport: { archived: string[]; tornDown?: string[]; skippedIds?: string[] };
    try {
      const resp = await deps.pruneInApp();
      if (!resp || !resp.ok) {
        const reason = resp && !resp.ok && typeof resp.error === 'string' ? resp.error : 'no answer from wmux';
        deps.console.error(`deck state --prune: ${reason}`);
        deps.exit(1);
        return 1;
      }
      const r = (resp.result ?? {}) as { archived?: unknown; tornDown?: unknown; skipped?: unknown };
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      pruneReport = { archived: strings(r.archived), tornDown: strings(r.tornDown), skippedIds: strings(r.skipped) };
    } catch (err) {
      deps.console.error(`deck state --prune: ${err instanceof Error ? err.message : String(err)}`);
      deps.exit(1);
      return 1;
    }

    // Re-list orphans
    const remainingReport = await reconcileOrphanDeckState(liveIds, {
      dir,
      now,
      dryRun: true,
      log: () => {
        /* quiet in CLI */
      },
    });

    const remainingFileMap = collectDeckWorkspaceFiles(dir);

    if (isJson) {
      const payload = {
        archived: pruneReport.archived,
        archive: archivePath,
        tornDown: pruneReport.tornDown ?? [],
        orphans: remainingReport.orphans,
        skipped: pruneReport.skippedIds ?? [],
        count: remainingReport.orphans.length,
      };
      deps.console.log(JSON.stringify(payload, null, 2));
    } else {
      const archivedStr = pruneReport.archived.length > 0 ? pruneReport.archived.join(', ') : 'none';
      deps.console.log(`archived: ${archivedStr}`);
      deps.console.log(`archive: ${archivePath}`);
      const tornDownStr =
        pruneReport.tornDown && pruneReport.tornDown.length > 0
          ? pruneReport.tornDown.join(', ')
          : 'none';
      deps.console.log(`torn down: ${tornDownStr}`);

      if (remainingReport.orphans.length === 0) {
        deps.console.log('orphans: 0');
      } else {
        const skippedSet = new Set(pruneReport.skippedIds ?? []);
        for (const id of remainingReport.orphans) {
          const files = remainingFileMap.get(id) ?? [];
          const filesStr = files.length > 0 ? files.join(', ') : 'none';
          if (skippedSet.has(id)) {
            deps.console.log(`${id}: ${filesStr} (skipped: parked work younger than TTL)`);
          } else {
            deps.console.log(`${id}: ${filesStr}`);
          }
        }
        deps.console.log(`orphans: ${remainingReport.orphans.length}`);
      }
    }
    return 0;
  }

  // orphansMode
  const report = await reconcileOrphanDeckState(liveIds, {
    dir,
    now,
    dryRun: true,
    log: () => {
      /* quiet in CLI */
    },
  });

  const fileMap = collectDeckWorkspaceFiles(dir);

  if (isJson) {
    const filesObj: Record<string, string[]> = {};
    for (const id of report.orphans) {
      filesObj[id] = fileMap.get(id) ?? [];
    }
    const payload = {
      orphans: report.orphans,
      files: filesObj,
      count: report.orphans.length,
    };
    deps.console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const id of report.orphans) {
      const files = fileMap.get(id) ?? [];
      const filesStr = files.length > 0 ? files.join(', ') : 'none';
      deps.console.log(`${id}: ${filesStr}`);
    }
    deps.console.log(`orphans: ${report.orphans.length}`);
  }
  return 0;
}

/**
 * CLI entry point for `wmux deck ...`.
 */
export async function handleDeck(
  args: string[],
  jsonModeOrDeps?: boolean | Partial<DeckDeps>,
  depsOverride?: Partial<DeckDeps>,
): Promise<void> {
  let jsonMode = false;
  let overrides: Partial<DeckDeps> | undefined;

  if (typeof jsonModeOrDeps === 'boolean') {
    jsonMode = jsonModeOrDeps;
    overrides = depsOverride;
  } else if (typeof jsonModeOrDeps === 'object' && jsonModeOrDeps !== null) {
    overrides = jsonModeOrDeps;
    if (typeof depsOverride === 'boolean') {
      jsonMode = depsOverride;
    }
  }

  const deps = createDefaultDeckDeps(overrides);
  await runDeck(args, deps, jsonMode);
}
