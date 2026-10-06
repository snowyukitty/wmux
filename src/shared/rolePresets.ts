// ─── Role presets (Settings → Roles & fan-out) ───────────────────────────────
//
// A preset is a ready-made binding for ONE role, so two roles that share a
// provider (Builder and Tester both on agy) still get different settings. It is
// a shortcut that writes the same fields a row edit would; nothing about the
// preset itself is stored, and the row stays editable afterwards.
//
// What a preset may differ on is limited to what wmux controls at launch:
// model, effort, skip-permissions. agy 1.2.14 has no per-launch flag for MCP
// servers, skills or hooks (`agy --help`), so those stay the shared, global
// surface — a preset never pretends otherwise, and never touches `tools`.
//
//   Builder  writes the code: the stronger tier, skips prompts so it can edit
//            and run unattended.
//   Tester   runs the suite and reads the output: a cheaper tier, same skip.
//
// Agent, MODEL, extra args and fresh-context are kept as the operator set them
// (owner decision: a preset fills a model only when none is chosen). An unbound
// role gets agy, the CLI both roles are run on here. For agy the effort IS the
// model id suffix, so the preset moves a chosen model to the tier's suffix
// within the SAME family when that family has the tier (Flash: low|medium|high)
// and leaves any other model exactly as chosen.
//
// Skip permissions is part of both presets, and the Settings button says so
// in its label and asks before applying (owner decision): one click turns
// every launch of the role, role-routed fan-out tasks included, to bypass.

import { agyFamilyOf } from './modelCatalog';
import { launchGrammarFor } from './agentLaunchOptions';
import type { OrchestratorRoleBindings, RoleBinding } from './orchestratorRole';

export const ROLE_PRESET_ROLES = ['Builder', 'Tester'] as const;
export type RolePresetRole = (typeof ROLE_PRESET_ROLES)[number];

type Tier = 'low' | 'medium' | 'high';

interface RolePresetSpec {
  tier: Tier;
  claudeModel: string;
  skipPermissions: boolean;
}

export const ROLE_PRESET_SPECS: Readonly<Record<RolePresetRole, RolePresetSpec>> = {
  Builder: { tier: 'high', claudeModel: 'claude-sonnet-5-5', skipPermissions: true },
  Tester: { tier: 'medium', claudeModel: 'claude-sonnet-5-5', skipPermissions: true },
};

export const ROLE_PRESET_DEFAULT_AGENT = 'agy';

/** Verified against `agy models` 2026-10-01: the Flash family has low|medium|high. */
const DEFAULT_AGY_FLASH = 'gemini-3.8-flash';

export function hasRolePreset(role: string): role is RolePresetRole {
  return (ROLE_PRESET_ROLES as readonly string[]).includes(role);
}

/** The binding a preset produces from the role's current one. */
export function applyRolePreset(role: RolePresetRole, current: RoleBinding | undefined): RoleBinding {
  const spec = ROLE_PRESET_SPECS[role];
  const next: RoleBinding = { ...current, agent: current?.agent || ROLE_PRESET_DEFAULT_AGENT };
  if (next.agent === 'agy') {
    // Effort is the model id suffix. No model yet: the Flash default at this
    // tier. A Flash model: same family, this tier. Any other family (3.1 Pro
    // has no `-medium`) keeps the model the operator chose, untouched.
    const family = current?.model ? agyFamilyOf(current.model) : '';
    if (!current?.model) next.model = `${DEFAULT_AGY_FLASH}-${spec.tier}`;
    else if (/-flash$/.test(family)) next.model = `${family}-${spec.tier}`;
    delete next.effort;
  } else if (next.agent === 'claude') {
    next.model = current?.model || spec.claudeModel;
    next.effort = spec.tier;
  } else if (next.agent === 'codex') {
    next.effort = spec.tier;
  }
  // Only for an agent with a verified skip flag; elsewhere it would be inert.
  if (spec.skipPermissions && launchGrammarFor(next.agent)?.skipPermissionsFlag) next.skipPermissions = true;
  return next;
}

/** Will applying the preset turn on skip permissions for this role? (Only for
 *  an agent with a verified skip flag; the button and confirm say so.) */
export function rolePresetSkipsPermissions(role: RolePresetRole, current: RoleBinding | undefined): boolean {
  return applyRolePreset(role, current).skipPermissions === true;
}

/** Does the role's binding already equal what its preset would write? */
export function rolePresetApplied(role: RolePresetRole, bindings: OrchestratorRoleBindings): boolean {
  const cur = bindings[role];
  if (!cur?.agent) return false;
  const next = applyRolePreset(role, cur);
  return (
    (cur.model ?? '') === (next.model ?? '') &&
    (cur.effort ?? '') === (next.effort ?? '') &&
    !!cur.skipPermissions === !!next.skipPermissions
  );
}
