// Provider-neutral contract for the "surface" (what a CLI loads into context): MCP servers, tools, skills,
// plugins and hooks. Read side is the inventory; write side is preview/apply of toggles.

import type { QuotaProviderId } from './quotaTypes';

export type SurfaceProviderId = QuotaProviderId;

export type SurfaceKind = 'mcp-server' | 'mcp-tool' | 'skill' | 'plugin' | 'hook' | 'builtin-tool' | 'context-setting';

/** Where the entry is defined. 'wmux' entries are installed by wmux itself and need a warning before toggling. */
export type SurfaceSource = 'user' | 'project' | 'plugin' | 'wmux' | 'builtin' | 'managed';

/**
 * What turning the item off does.
 * 'removes' = leaves the model's context (saves tokens); 'blocks' = only denies/asks at use time (no saving);
 * 'cost' = enabling it spends more (e.g. fast mode); 'none' = informational.
 */
export type SurfaceEffect = 'removes' | 'blocks' | 'cost' | 'none';

/** Why a hook costs tokens; inferred from event + handler type. */
export type HookCostHint = 'injects-context' | 'calls-model' | 'extra-turn' | 'none';

export interface SurfaceItem {
  /** Stable id: `${provider}:${kind}:${parent ?? ''}:${name}` with parts URI-encoded. */
  id: string;
  provider: SurfaceProviderId;
  kind: SurfaceKind;
  name: string;
  /** Parent item name, e.g. the MCP server that owns an 'mcp-tool'. */
  parent: string | null;
  source: SurfaceSource;
  /** Current state; null when it cannot be determined. */
  enabled: boolean | null;
  effect: SurfaceEffect;
  /** False when the adapter can only read this item (managed, built-in, unsupported CLI version, ...). */
  toggleable: boolean;
  /** Short reason shown when toggleable is false. */
  readOnlyReason: string | null;
  /** Hooks only. */
  hookEvent: string | null;
  hookCost: HookCostHint | null;
  /**
   * Hooks only: hash of the event, matcher group and handler as listed. Unnamed handlers share a name
   * (`<event>-<type>`), so writers match on this instead of the name.
   */
  hookFingerprint?: string;
  /** Skills only: size of name + description that enters the context. */
  descriptionChars: number | null;
  /** File the item was read from, for display and conflict checks. */
  originPath: string | null;
  /** Claude: the settings file that holds this item's deny or override, when one exists. */
  settingsPath?: string;
  /** True for wmux's own MCP server / hooks. */
  wmuxRequired: boolean;
}

export interface ProviderInventory {
  provider: SurfaceProviderId;
  /** Output of `<cli> --version`, null when the CLI is missing. */
  cliVersion: string | null;
  /** False when the version is outside the tested range; the adapter is read-only then. */
  versionSupported: boolean;
  writable: boolean;
  items: SurfaceItem[];
  warnings: string[];
  scannedAtMs: number;
}

export interface SurfaceChange {
  itemId: string;
  enabled: boolean;
}

export interface SurfaceFileEdit {
  path: string;
  /** Short, human description such as "set plugins.\"x@y\".enabled = false". */
  summary: string;
}

export interface SurfacePreview {
  provider: SurfaceProviderId;
  edits: SurfaceFileEdit[];
  /** Changes the adapter refuses, with a reason each. */
  rejected: { itemId: string; reason: string }[];
  /** Shown as "takes effect on the next CLI session". */
  requiresNewSession: boolean;
}

export interface SurfaceApplyResult {
  provider: SurfaceProviderId;
  ok: boolean;
  appliedItemIds: string[];
  backups: string[];
  error: string | null;
}

export interface SurfaceInventoryRequest {
  provider: SurfaceProviderId;
}

export interface SurfaceChangeRequest {
  provider: SurfaceProviderId;
  changes: SurfaceChange[];
  /** Must be true to toggle items wmux itself needs (its MCP server and hooks). */
  allowWmuxRequired?: boolean;
}
