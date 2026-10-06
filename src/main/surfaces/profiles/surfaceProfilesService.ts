import * as crypto from 'crypto';
import type {
  ApplyProfileOptions,
  ProfileApplyAggregateResult,
  ProfileApplyProviderResult,
  ProfilePreviewProviderResult,
  ProfilePreviewResult,
  SaveProfileResult,
  SurfaceProfile,
  SurfaceProfileProviderState,
} from '../../../shared/tokenUsage/profileTypes';
import type {
  SurfaceChange,
  SurfaceProviderId,
} from '../../../shared/tokenUsage/surfaceTypes';
import { readInventory, type InventoryDeps } from '../inventory';
import {
  applySurfaceChanges,
  defaultWriterDeps,
  previewSurfaceChanges,
  type SurfaceChangeOptions,
  type WriterDeps,
  type WriterRegistry,
} from '../writers';
import { SurfacesStore } from '../safeWrite/surfacesStore';
import { assertValidProviders, validateProfileName } from './profileValidation';

export interface ProfileServiceOptions {
  deps?: WriterDeps;
  inventoryDeps?: Partial<InventoryDeps>;
  storePath?: string;
  store?: SurfacesStore;
  writers?: WriterRegistry;
}

export interface ProfileApplyServiceOptions extends ProfileServiceOptions, ApplyProfileOptions {}

function getStore(options?: ProfileServiceOptions): SurfacesStore {
  if (options?.store) {
    return options.store;
  }
  const deps = options?.deps ?? defaultWriterDeps();
  const storePath = options?.storePath ?? deps.surfacesStorePath;
  const store = new SurfacesStore(storePath);
  store.load();
  return store;
}

export async function listProfiles(options?: ProfileServiceOptions): Promise<SurfaceProfile[]> {
  const store = getStore(options);
  return store.profiles.list();
}

export async function getProfile(id: string, options?: ProfileServiceOptions): Promise<SurfaceProfile | undefined> {
  const store = getStore(options);
  return store.profiles.get(id);
}

export async function saveProfile(
  name: string,
  providers?: SurfaceProviderId[],
  options?: ProfileServiceOptions,
): Promise<SaveProfileResult> {
  const trimmedName = validateProfileName(name);
  const targetProviders =
    providers && providers.length > 0
      ? assertValidProviders(providers)
      : (['claude', 'codex', 'agy'] as SurfaceProviderId[]);

  const store = getStore(options);
  if (store.profiles.getByName(trimmedName)) {
    throw new Error('A profile with this name already exists.');
  }
  if (store.profiles.list().length >= 50) {
    throw new Error('Maximum number of profiles (50) reached.');
  }

  const skippedProviders: { provider: SurfaceProviderId; reason: string }[] = [];
  const capturedProviders: Partial<Record<SurfaceProviderId, SurfaceProfileProviderState>> = {};

  const deps = options?.deps ?? defaultWriterDeps();
  const invDeps: Partial<InventoryDeps> = {
    homeDir: deps.homeDir,
    run: deps.run,
    now: deps.now,
    ...options?.inventoryDeps,
  };

  for (const provider of targetProviders) {
    try {
      const inventory = await readInventory(provider, invDeps);
      if (!inventory.writable) {
        skippedProviders.push({ provider, reason: 'Editing is disabled for this CLI version' });
        continue;
      }

      const toggleableItems = inventory.items.filter((item) => item.toggleable && !item.wmuxRequired);
      const knownItemIds = toggleableItems.map((item) => item.id);
      const disabledItemIds = toggleableItems
        .filter((item) => item.enabled === false)
        .map((item) => item.id);

      capturedProviders[provider] = {
        knownItemIds,
        disabledItemIds,
      };
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
      let reason = 'Could not read the configuration';
      if (msg.includes('version not supported') || msg.includes('unsupported version')) {
        reason = 'CLI version not supported';
      } else if (msg.includes('editing is disabled') || msg.includes('disabled for this cli version')) {
        reason = 'Editing is disabled for this CLI version';
      }
      skippedProviders.push({ provider, reason });
    }
  }

  const profile: SurfaceProfile = {
    id: crypto.randomUUID(),
    name: trimmedName,
    createdAt: deps.now ? deps.now() : Date.now(),
    providers: capturedProviders,
  };

  store.profiles.add(profile);
  try {
    store.save();
  } catch (err) {
    const msg = (err as Error).message || '';
    if (msg.includes('already exists')) {
      throw new Error('A profile with this name already exists.');
    }
    if (msg.startsWith('Maximum number of profiles')) {
      throw new Error('Maximum number of profiles (50) reached.');
    }
    throw new Error('Storage version is not supported.');
  }

  return {
    ok: true,
    profile,
    skippedProviders: skippedProviders.length > 0 ? skippedProviders : undefined,
  };
}

export async function deleteProfile(id: string, options?: ProfileServiceOptions): Promise<boolean> {
  const store = getStore(options);
  const deleted = store.profiles.delete(id);
  if (deleted) {
    try {
      store.save();
    } catch {
      throw new Error('Storage version is not supported.');
    }
  }
  return deleted;
}

export async function previewProfile(
  id: string,
  options?: ProfileServiceOptions,
): Promise<ProfilePreviewResult> {
  const store = getStore(options);
  const profile = store.profiles.get(id);
  if (!profile) {
    throw new Error('Profile not found.');
  }

  const deps = options?.deps ?? defaultWriterDeps();
  const invDeps: Partial<InventoryDeps> = {
    homeDir: deps.homeDir,
    run: deps.run,
    now: deps.now,
    ...options?.inventoryDeps,
  };

  const providersResult: Partial<Record<SurfaceProviderId, ProfilePreviewProviderResult>> = {};
  let totalMissingCount = 0;
  const allMissingIds: string[] = [];
  let totalNewCount = 0;
  let totalSkippedWmuxRequired = 0;
  let allOk = true;

  const entries = Object.entries(profile.providers) as [SurfaceProviderId, SurfaceProfileProviderState][];

  for (const [provider, state] of entries) {
    try {
      const inventory = await readInventory(provider, invDeps);
      const liveMap = new Map(inventory.items.map((i) => [i.id, i]));
      const capturedKnownSet = new Set(state.knownItemIds);

      const missingForProvider = state.knownItemIds.filter((itemId) => !liveMap.has(itemId));
      totalMissingCount += missingForProvider.length;
      allMissingIds.push(...missingForProvider);

      const newForProvider = inventory.items.filter(
        (i) => i.toggleable && !i.wmuxRequired && !capturedKnownSet.has(i.id),
      );
      totalNewCount += newForProvider.length;

      let skippedWmuxRequired = 0;
      const disabledSet = new Set(state.disabledItemIds);
      const changes: SurfaceChange[] = [];
      for (const itemId of state.knownItemIds) {
        const item = liveMap.get(itemId);
        if (!item) continue;
        if (item.wmuxRequired) {
          skippedWmuxRequired++;
          continue;
        }
        const desiredEnabled = !disabledSet.has(itemId);
        if (item.enabled !== desiredEnabled) {
          changes.push({ itemId, enabled: desiredEnabled });
        }
      }
      totalSkippedWmuxRequired += skippedWmuxRequired;

      const previewOpts: SurfaceChangeOptions = {
        deps,
        writers: options?.writers,
        inventoryDeps: invDeps,
      };
      const preview = await previewSurfaceChanges({ provider, changes }, previewOpts);

      providersResult[provider] = {
        ...preview,
        missingCount: missingForProvider.length,
        newItemsCount: newForProvider.length,
        skippedWmuxRequired,
      };
    } catch {
      allOk = false;
      providersResult[provider] = {
        provider,
        edits: [],
        rejected: [{ itemId: '', reason: 'Preview failed for provider.' }],
        requiresNewSession: true,
        missingCount: 0,
        newItemsCount: 0,
      };
    }
  }

  return {
    ok: allOk,
    providers: providersResult,
    missing: {
      count: totalMissingCount,
      firstFewIds: allMissingIds.slice(0, 5),
      ids: allMissingIds,
    },
    newItems: totalNewCount,
    skippedWmuxRequired: totalSkippedWmuxRequired,
  };
}

export async function applyProfile(
  id: string,
  options?: ProfileApplyServiceOptions,
): Promise<ProfileApplyAggregateResult> {
  const store = getStore(options);
  const profile = store.profiles.get(id);
  if (!profile) {
    throw new Error('Profile not found.');
  }

  const deps = options?.deps ?? defaultWriterDeps();
  const invDeps: Partial<InventoryDeps> = {
    homeDir: deps.homeDir,
    run: deps.run,
    now: deps.now,
    ...options?.inventoryDeps,
  };

  const providersResult: Partial<Record<SurfaceProviderId, ProfileApplyProviderResult>> = {};
  let totalMissingCount = 0;
  const allMissingIds: string[] = [];
  let totalNewCount = 0;
  let totalSkippedWmuxRequired = 0;
  let allOk = true;

  const entries = Object.entries(profile.providers) as [SurfaceProviderId, SurfaceProfileProviderState][];

  for (const [provider, state] of entries) {
    try {
      const inventory = await readInventory(provider, invDeps);
      const liveMap = new Map(inventory.items.map((i) => [i.id, i]));
      const capturedKnownSet = new Set(state.knownItemIds);

      const missingForProvider = state.knownItemIds.filter((itemId) => !liveMap.has(itemId));
      totalMissingCount += missingForProvider.length;
      allMissingIds.push(...missingForProvider);

      const newForProvider = inventory.items.filter(
        (i) => i.toggleable && !i.wmuxRequired && !capturedKnownSet.has(i.id),
      );
      totalNewCount += newForProvider.length;

      let skippedWmuxRequired = 0;
      const disabledSet = new Set(state.disabledItemIds);
      const changes: SurfaceChange[] = [];
      for (const itemId of state.knownItemIds) {
        const item = liveMap.get(itemId);
        if (!item) continue;
        if (item.wmuxRequired) {
          skippedWmuxRequired++;
          continue;
        }
        const desiredEnabled = !disabledSet.has(itemId);
        if (item.enabled !== desiredEnabled) {
          changes.push({ itemId, enabled: desiredEnabled });
        }
      }
      totalSkippedWmuxRequired += skippedWmuxRequired;

      const applyOpts: SurfaceChangeOptions = {
        deps,
        writers: options?.writers,
        inventoryDeps: invDeps,
      };

      let applyRes: ProfileApplyProviderResult;
      if (changes.length === 0) {
        applyRes = {
          provider,
          ok: true,
          appliedItemIds: [],
          backups: [],
          error: null,
          nothingToChange: true,
          missingCount: missingForProvider.length,
          newItemsCount: newForProvider.length,
          skippedWmuxRequired,
        };
      } else {
        const res = await applySurfaceChanges(
          { provider, changes, allowWmuxRequired: false },
          applyOpts,
        );

        if (!res.ok) {
          if (res.error === 'Nothing to change.') {
            applyRes = {
              ...res,
              ok: true,
              nothingToChange: true,
              missingCount: missingForProvider.length,
              newItemsCount: newForProvider.length,
              skippedWmuxRequired,
            };
          } else {
            allOk = false;
            applyRes = {
              ...res,
              missingCount: missingForProvider.length,
              newItemsCount: newForProvider.length,
              skippedWmuxRequired,
            };
          }
        } else {
          applyRes = {
            ...res,
            missingCount: missingForProvider.length,
            newItemsCount: newForProvider.length,
            skippedWmuxRequired,
          };
        }
      }

      providersResult[provider] = applyRes;
    } catch {
      allOk = false;
      providersResult[provider] = {
        provider,
        ok: false,
        appliedItemIds: [],
        backups: [],
        error: 'Apply failed for provider.',
        missingCount: 0,
        newItemsCount: 0,
      };
    }
  }

  const provList = Object.values(providersResult);
  const totalApplied = provList.reduce((sum, p) => sum + (p?.appliedItemIds?.length ?? 0), 0);
  const isNoOp = allOk && totalApplied === 0;

  return {
    ok: allOk,
    ...(isNoOp ? { nothingToChange: true } : {}),
    providers: providersResult,
    missing: {
      count: totalMissingCount,
      firstFewIds: allMissingIds.slice(0, 5),
      ids: allMissingIds,
    },
    newItems: totalNewCount,
    skippedWmuxRequired: totalSkippedWmuxRequired,
  };
}
