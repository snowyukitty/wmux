import type { SurfaceEffect, SurfaceItem, SurfaceKind, SurfaceProviderId, SurfaceSource, HookCostHint } from '../../../shared/tokenUsage/surfaceTypes';

export type CliRunner = (command: string, args: readonly string[]) => Promise<string>;

export interface InventoryDeps {
  homeDir: string;
  projectDir?: string;
  surfacesStorePath?: string;
  run?: CliRunner;
  now?: () => number;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  readdir?: (path: string) => Promise<string[]>;
  stat?: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
  exists?: (path: string) => Promise<boolean>;
}

export const LOCATION_SOURCE_ORDER: Record<SurfaceSource, number> = {
  user: 0,
  project: 1,
  plugin: 2,
  builtin: 3,
  wmux: 4,
  managed: 5,
};

export function makeSurfaceItemId(
  provider: SurfaceProviderId,
  kind: SurfaceKind,
  parent: string | null,
  name: string,
  suffix?: string,
): string {
  const base = [
    encodeURIComponent(provider),
    encodeURIComponent(kind),
    encodeURIComponent(parent ?? ''),
    encodeURIComponent(name),
  ].join(':');
  return suffix ? `${base}${suffix}` : base;
}

export function allocateUniqueItemId(
  seenIds: Set<string>,
  baseId: string,
  source: SurfaceSource,
): string {
  if (!seenIds.has(baseId)) {
    seenIds.add(baseId);
    return baseId;
  }

  const firstCollision = `${baseId}@${source}`;
  if (!seenIds.has(firstCollision)) {
    seenIds.add(firstCollision);
    return firstCollision;
  }

  let n = 2;
  while (seenIds.has(`${baseId}@${source}#${n}`)) {
    n++;
  }
  const resolved = `${baseId}@${source}#${n}`;
  seenIds.add(resolved);
  return resolved;
}

export function makeItem(params: {
  provider: SurfaceProviderId;
  kind: SurfaceKind;
  name: string;
  parent?: string | null;
  source: SurfaceSource;
  enabled: boolean | null;
  effect: SurfaceEffect;
  toggleable: boolean;
  readOnlyReason?: string | null;
  hookEvent?: string | null;
  hookCost?: HookCostHint | null;
  hookFingerprint?: string;
  descriptionChars?: number | null;
  originPath?: string | null;
  wmuxRequired?: boolean;
}): SurfaceItem {
  const parent = params.parent ?? null;
  const id = makeSurfaceItemId(params.provider, params.kind, parent, params.name);

  return {
    id,
    provider: params.provider,
    kind: params.kind,
    name: params.name,
    parent,
    source: params.source,
    enabled: params.enabled,
    effect: params.effect,
    toggleable: params.toggleable,
    readOnlyReason: params.readOnlyReason ?? null,
    hookEvent: params.hookEvent ?? null,
    hookCost: params.hookCost ?? null,
    ...(params.hookFingerprint !== undefined ? { hookFingerprint: params.hookFingerprint } : {}),
    descriptionChars: params.descriptionChars ?? null,
    originPath: params.originPath ?? null,
    wmuxRequired: params.wmuxRequired ?? false,
  };
}
