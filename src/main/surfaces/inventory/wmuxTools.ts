import { CORE_TOOL_SURFACE } from '../../../shared/coreSurface';
import { capabilityFor } from '../../../shared/tokenUsage/capabilities';
import type { SurfaceItem, SurfaceProviderId } from '../../../shared/tokenUsage/surfaceTypes';
import { allocateUniqueItemId, makeItem, type InventoryDeps } from './types';

/**
 * Canonical tool names for wmux core tools.
 * Note: this is CORE_TOOL_SURFACE, not the full default tools/list.
 * browser_* and company_* tools are not included here.
 */
export function listWmuxToolNames(): readonly string[] {
  return CORE_TOOL_SURFACE;
}

export interface WmuxServerDeclaration {
  source: 'project' | 'user' | 'plugin';
  serverItem: SurfaceItem;
  disabledNames: Set<string> | readonly string[];
  originPath: string;
}

/**
 * Resolves the effective wmux server when declared in one or more places.
 * Precedence: project over user over plugin; deterministic tie-breaker by originPath.
 * When declared in several places (>1), produces a warning:
 * "wmux is declared in several places; tool switches apply to <source>"
 */
export function resolveEffectiveWmuxServer(
  declarations: readonly WmuxServerDeclaration[],
): { effective: WmuxServerDeclaration; warning: string | null } | null {
  if (declarations.length === 0) return null;
  if (declarations.length === 1) {
    return { effective: declarations[0], warning: null };
  }

  const precedence: Record<'project' | 'user' | 'plugin', number> = {
    project: 3,
    user: 2,
    plugin: 1,
  };

  const sorted = [...declarations].sort((a, b) => {
    const diff = precedence[b.source] - precedence[a.source];
    if (diff !== 0) return diff;
    return a.originPath.localeCompare(b.originPath);
  });

  const effective = sorted[0];
  const warning = `wmux is declared in several places; tool switches apply to ${effective.source}`;
  return { effective, warning };
}

export function wmuxToolItems(
  provider: SurfaceProviderId,
  serverItem: SurfaceItem,
  disabledNames: Set<string> | readonly string[],
  _deps?: InventoryDeps,
): SurfaceItem[] {
  const cap = capabilityFor(provider, 'mcp-tool');
  const effect = cap?.effect ?? 'removes';
  const toggleable = cap ? cap.status !== 'unsupported' : true;
  const disabledSet = disabledNames instanceof Set ? disabledNames : new Set(disabledNames);

  const seenIds = new Set<string>();
  const toolNames = listWmuxToolNames();
  const items: SurfaceItem[] = [];

  for (const name of toolNames) {
    const rawItem = makeItem({
      provider,
      kind: 'mcp-tool',
      name,
      parent: 'wmux',
      source: 'wmux',
      enabled: !disabledSet.has(name),
      effect,
      toggleable,
      originPath: serverItem.originPath ?? null,
      wmuxRequired: false,
    });
    const uniqueId = allocateUniqueItemId(seenIds, rawItem.id, 'wmux');
    items.push({
      ...rawItem,
      id: uniqueId,
    });
  }

  return items;
}
