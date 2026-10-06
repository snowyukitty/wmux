import * as fs from 'fs';
import { writeFileAtomic } from './atomicWrite';
import type { SurfaceProfile } from '../../../shared/tokenUsage/profileTypes';

export interface RemovedHookEntry {
  id: string;
  definition: unknown;
  originPath?: string;
}

export interface SurfacesStoreData {
  version: number;
  intents?: Record<string, Record<string, boolean>>;
  removedHooks?: Record<string, RemovedHookEntry[]>;
  profiles?: SurfaceProfile[];
  [key: string]: unknown;
}

export interface SurfacesStoreDeps {
  readFile?: (path: string, encoding: 'utf8') => string;
}

export interface SurfacesStoreSaveOptions {
  replaceCorrupt?: boolean;
}

function isValidProfile(item: unknown): item is SurfaceProfile {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const p = item as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id.trim()) return false;
  if (typeof p.name !== 'string') return false;
  const trimmedName = p.name.trim();
  if (trimmedName.length < 1 || trimmedName.length > 40) return false;
  if (typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt)) return false;
  if (!p.providers || typeof p.providers !== 'object' || Array.isArray(p.providers)) return false;
  const validProviders = new Set(['claude', 'codex', 'agy']);
  for (const [k, v] of Object.entries(p.providers as Record<string, unknown>)) {
    if (!validProviders.has(k)) return false;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const provState = v as Record<string, unknown>;
    if (!Array.isArray(provState.knownItemIds) || !provState.knownItemIds.every((id) => typeof id === 'string')) {
      return false;
    }
    if (!Array.isArray(provState.disabledItemIds) || !provState.disabledItemIds.every((id) => typeof id === 'string')) {
      return false;
    }
  }
  return true;
}

type StoreMutation =
  | { type: 'recordIntent'; provider: string; itemId: string; wantedEnabled: boolean }
  | { type: 'addRemovedHook'; provider: string; hook: RemovedHookEntry }
  | { type: 'takeRemovedHook'; provider: string; id: string }
  | { type: 'addProfile'; profile: SurfaceProfile }
  | { type: 'deleteProfile'; id: string }
  | { type: 'setProfiles'; profiles: SurfaceProfile[] };

let saveProcessLock = false;

export class SurfacesStore {
  readonly filePath: string;
  readonly warnings: string[] = [];

  private intents: Record<string, Record<string, boolean>> = {};
  private removedHooksStore: Record<string, RemovedHookEntry[]> = {};
  private profilesList: SurfaceProfile[] = [];
  private unknownKeys: Record<string, unknown> = {};
  private hasProfilesKey = false;
  private hasRefusedVersion = false;
  private mutations: StoreMutation[] = [];

  readonly removedHooks = {
    add: (provider: string, hook: RemovedHookEntry): void => {
      if (!this.removedHooksStore[provider]) {
        this.removedHooksStore[provider] = [];
      }
      const list = this.removedHooksStore[provider];
      const idx = list.findIndex((h) => h.id === hook.id);
      if (idx !== -1) {
        list[idx] = hook;
      } else {
        list.push(hook);
      }
      this.mutations.push({ type: 'addRemovedHook', provider, hook: { ...hook } });
    },

    take: (provider: string, id: string): RemovedHookEntry | undefined => {
      const list = this.removedHooksStore[provider];
      if (!list) return undefined;
      const idx = list.findIndex((h) => h.id === id);
      if (idx === -1) return undefined;
      const [item] = list.splice(idx, 1);
      if (item) {
        this.mutations.push({ type: 'takeRemovedHook', provider, id });
      }
      return item;
    },

    get: (provider: string, id: string): RemovedHookEntry | undefined => {
      const list = this.removedHooksStore[provider];
      return list?.find((h) => h.id === id);
    },

    list: (provider: string): RemovedHookEntry[] => {
      return [...(this.removedHooksStore[provider] ?? [])];
    },
  };

  readonly profiles = {
    list: (): SurfaceProfile[] => [...this.profilesList],
    get: (id: string): SurfaceProfile | undefined => this.profilesList.find((p) => p.id === id),
    getByName: (name: string): SurfaceProfile | undefined => {
      const lower = name.trim().toLowerCase();
      return this.profilesList.find((p) => p.name.trim().toLowerCase() === lower);
    },
    add: (profile: SurfaceProfile): void => {
      const trimmedName = profile.name.trim();
      if (trimmedName.length < 1 || trimmedName.length > 40) {
        throw new Error('Profile name must be between 1 and 40 characters');
      }
      const existing = this.profilesList.find(
        (p) => p.id !== profile.id && p.name.trim().toLowerCase() === trimmedName.toLowerCase(),
      );
      if (existing) {
        throw new Error('A profile with this name already exists');
      }
      const idx = this.profilesList.findIndex((p) => p.id === profile.id);
      if (idx !== -1) {
        this.profilesList[idx] = { ...profile, name: trimmedName };
      } else {
        if (this.profilesList.length >= 50) {
          throw new Error('Maximum number of profiles (50) reached');
        }
        this.profilesList.push({ ...profile, name: trimmedName });
      }
      this.hasProfilesKey = true;
      this.mutations.push({ type: 'addProfile', profile: { ...profile, name: trimmedName } });
    },
    delete: (id: string): boolean => {
      const idx = this.profilesList.findIndex((p) => p.id === id);
      if (idx === -1) return false;
      this.profilesList.splice(idx, 1);
      this.hasProfilesKey = true;
      this.mutations.push({ type: 'deleteProfile', id });
      return true;
    },
    set: (profiles: SurfaceProfile[]): void => {
      if (profiles.length > 50) {
        throw new Error('Maximum number of profiles (50) reached');
      }
      this.profilesList = [...profiles];
      this.hasProfilesKey = true;
      this.mutations.push({ type: 'setProfiles', profiles: [...profiles] });
    },
  };

  private readonly readFile: (path: string, encoding: 'utf8') => string;

  constructor(filePath: string, deps?: SurfacesStoreDeps) {
    this.filePath = filePath;
    this.readFile = deps?.readFile ?? ((p, enc) => fs.readFileSync(p, enc));
  }

  load(): void {
    this.intents = {};
    this.removedHooksStore = {};
    this.profilesList = [];
    this.unknownKeys = {};
    this.hasProfilesKey = false;
    this.hasRefusedVersion = false;
    this.mutations = [];

    if (!fs.existsSync(this.filePath)) {
      return;
    }

    let parsed: unknown;
    try {
      const content = this.readFile(this.filePath, 'utf8');
      parsed = JSON.parse(content);
    } catch (err) {
      this.warnings.push(`Corrupt surfaces store file: ${(err as Error).message}`);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.warnings.push('Corrupt surfaces store: content is not a JSON object');
      return;
    }

    const data = parsed as SurfacesStoreData;
    if (typeof data.version !== 'number' || data.version !== 1) {
      this.warnings.push(`Unknown or unsupported surfaces store version: ${data.version}`);
      this.hasRefusedVersion = true;
      return;
    }

    const knownKeys = new Set(['version', 'intents', 'removedHooks', 'profiles']);
    for (const [key, val] of Object.entries(data)) {
      if (!knownKeys.has(key)) {
        this.unknownKeys[key] = val;
      }
    }

    if (data.intents && typeof data.intents === 'object') {
      this.intents = data.intents;
    }
    if (data.removedHooks && typeof data.removedHooks === 'object') {
      this.removedHooksStore = data.removedHooks;
    }

    if ('profiles' in data) {
      this.hasProfilesKey = true;
      if (!Array.isArray(data.profiles)) {
        this.warnings.push('Corrupt surfaces store: profiles is not an array');
      } else {
        for (const item of data.profiles) {
          if (isValidProfile(item)) {
            if (this.profilesList.length < 50) {
              this.profilesList.push({ ...item, name: item.name.trim() });
            } else {
              this.warnings.push('Profile limit exceeded: maximum 50 profiles stored');
            }
          } else {
            this.warnings.push('Dropping corrupt or invalid profile entry');
          }
        }
      }
    }
  }

  save(options?: SurfacesStoreSaveOptions): void {
    if (saveProcessLock) {
      // Serialized within process
    }
    saveProcessLock = true;
    try {
      this.saveInternal(options);
    } finally {
      saveProcessLock = false;
    }
  }

  private saveInternal(options?: SurfacesStoreSaveOptions): void {
    if (this.hasRefusedVersion) {
      const msg = 'Refusing to save: newer version file exists on disk';
      this.warnings.push(msg);
      throw new Error(msg);
    }

    let diskUnknownKeys: Record<string, unknown> = { ...this.unknownKeys };
    let diskIntents: Record<string, Record<string, boolean>> = {};
    let diskRemovedHooks: Record<string, RemovedHookEntry[]> = {};
    let diskProfiles: SurfaceProfile[] = [];
    let diskHasProfilesKey = this.hasProfilesKey;

    if (fs.existsSync(this.filePath)) {
      let raw: string;
      try {
        raw = this.readFile(this.filePath, 'utf8');
      } catch (err) {
        const msg = `Refusing to save: cannot read existing store file: ${(err as Error).message}`;
        this.warnings.push(msg);
        throw new Error(msg);
      }

      let parsed: unknown;
      let parseFailed = false;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        parseFailed = true;
        if (!options?.replaceCorrupt) {
          const msg = `Refusing to save: corrupt surfaces store file on disk: ${(err as Error).message}`;
          this.warnings.push(msg);
          throw new Error(msg);
        }
      }

      if (!parseFailed && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
        parseFailed = true;
        if (!options?.replaceCorrupt) {
          const msg = 'Refusing to save: corrupt surfaces store file on disk: content is not a JSON object';
          this.warnings.push(msg);
          throw new Error(msg);
        }
      }

      if (parseFailed && options?.replaceCorrupt) {
        for (const [provider, items] of Object.entries(this.intents)) {
          diskIntents[provider] = { ...items };
        }
        for (const [provider, hooks] of Object.entries(this.removedHooksStore)) {
          diskRemovedHooks[provider] = [...hooks];
        }
        diskProfiles = [...this.profilesList];
      } else if (!parseFailed) {
        const diskData = parsed as SurfacesStoreData;
        if (typeof diskData.version === 'number' && diskData.version > 1) {
          const msg = `Refusing to save: newer version ${diskData.version} detected on disk`;
          this.warnings.push(msg);
          this.hasRefusedVersion = true;
          throw new Error(msg);
        }
        if (typeof diskData.version !== 'number' || diskData.version !== 1) {
          const msg = `Refusing to save: unsupported surfaces store version: ${diskData.version}`;
          this.warnings.push(msg);
          this.hasRefusedVersion = true;
          throw new Error(msg);
        }

        const knownKeys = new Set(['version', 'intents', 'removedHooks', 'profiles']);
        for (const [key, val] of Object.entries(diskData)) {
          if (!knownKeys.has(key)) {
            diskUnknownKeys[key] = val;
          }
        }

        if (diskData.intents && typeof diskData.intents === 'object') {
          for (const [provider, items] of Object.entries(diskData.intents)) {
            if (items && typeof items === 'object') {
              diskIntents[provider] = { ...(items as Record<string, boolean>) };
            }
          }
        }

        if (diskData.removedHooks && typeof diskData.removedHooks === 'object') {
          for (const [provider, hooks] of Object.entries(diskData.removedHooks)) {
            if (Array.isArray(hooks)) {
              diskRemovedHooks[provider] = [...hooks];
            }
          }
        }

        if ('profiles' in diskData) {
          diskHasProfilesKey = true;
          if (Array.isArray(diskData.profiles)) {
            for (const item of diskData.profiles) {
              if (isValidProfile(item) && diskProfiles.length < 50) {
                diskProfiles.push({ ...item, name: item.name.trim() });
              }
            }
          }
        }
      }
    } else {
      for (const [provider, items] of Object.entries(this.intents)) {
        diskIntents[provider] = { ...items };
      }
      for (const [provider, hooks] of Object.entries(this.removedHooksStore)) {
        diskRemovedHooks[provider] = [...hooks];
      }
      diskProfiles = [...this.profilesList];
    }

    // Apply THIS instance's recorded mutations on top of fresh content
    for (const mutation of this.mutations) {
      switch (mutation.type) {
        case 'recordIntent': {
          if (!diskIntents[mutation.provider]) {
            diskIntents[mutation.provider] = {};
          }
          diskIntents[mutation.provider][mutation.itemId] = mutation.wantedEnabled;
          break;
        }
        case 'addRemovedHook': {
          if (!diskRemovedHooks[mutation.provider]) {
            diskRemovedHooks[mutation.provider] = [];
          }
          const list = diskRemovedHooks[mutation.provider];
          const idx = list.findIndex((h) => h.id === mutation.hook.id);
          if (idx !== -1) {
            list[idx] = mutation.hook;
          } else {
            list.push(mutation.hook);
          }
          break;
        }
        case 'takeRemovedHook': {
          const list = diskRemovedHooks[mutation.provider];
          if (list) {
            const idx = list.findIndex((h) => h.id === mutation.id);
            if (idx !== -1) {
              list.splice(idx, 1);
            }
          }
          break;
        }
        case 'addProfile': {
          diskHasProfilesKey = true;
          const trimmedName = mutation.profile.name.trim();
          const lowerName = trimmedName.toLowerCase();
          const existingWithName = diskProfiles.find(
            (p) => p.id !== mutation.profile.id && p.name.trim().toLowerCase() === lowerName,
          );
          if (existingWithName) {
            const msg = 'A profile with this name already exists';
            this.warnings.push(msg);
            throw new Error(msg);
          }
          const idx = diskProfiles.findIndex((p) => p.id === mutation.profile.id);
          if (idx !== -1) {
            diskProfiles[idx] = { ...mutation.profile, name: trimmedName };
          } else {
            if (diskProfiles.length >= 50) {
              const msg = 'Maximum number of profiles (50) reached';
              this.warnings.push(msg);
              throw new Error(msg);
            }
            diskProfiles.push({ ...mutation.profile, name: trimmedName });
          }
          break;
        }
        case 'deleteProfile': {
          diskHasProfilesKey = true;
          const idx = diskProfiles.findIndex((p) => p.id === mutation.id);
          if (idx !== -1) {
            diskProfiles.splice(idx, 1);
          }
          break;
        }
        case 'setProfiles': {
          diskHasProfilesKey = true;
          diskProfiles = [...mutation.profiles];
          break;
        }
      }
    }

    const payload: SurfacesStoreData = {
      ...diskUnknownKeys,
      version: 1,
      intents: diskIntents,
      removedHooks: diskRemovedHooks,
    };

    if (diskHasProfilesKey || diskProfiles.length > 0) {
      payload.profiles = diskProfiles;
    }

    // Cross-process file race remains a known limit.
    writeFileAtomic(this.filePath, JSON.stringify(payload, null, 2) + '\n');

    this.intents = diskIntents;
    this.removedHooksStore = diskRemovedHooks;
    this.profilesList = diskProfiles;
    this.unknownKeys = diskUnknownKeys;
    this.hasProfilesKey = diskHasProfilesKey;
    this.mutations = [];
  }

  recordIntent(provider: string, itemId: string, wantedEnabled: boolean): void {
    if (!this.intents[provider]) {
      this.intents[provider] = {};
    }
    this.intents[provider][itemId] = wantedEnabled;
    this.mutations.push({ type: 'recordIntent', provider, itemId, wantedEnabled });
  }

  getIntent(provider: string, itemId: string): boolean | undefined {
    return this.intents[provider]?.[itemId];
  }

  reconcile(
    provider: string,
    currentItemIds: string[],
  ): { newItems: string[]; removedItems: string[] } {
    const recordedMap = this.intents[provider] ?? {};
    const recordedIds = Object.keys(recordedMap);
    const recordedSet = new Set(recordedIds);
    const currentSet = new Set(currentItemIds);

    const newItems = currentItemIds.filter((id) => !recordedSet.has(id));
    const removedItems = recordedIds.filter((id) => !currentSet.has(id));

    return { newItems, removedItems };
  }

  listProfiles(): SurfaceProfile[] {
    return this.profiles.list();
  }

  getProfile(id: string): SurfaceProfile | undefined {
    return this.profiles.get(id);
  }

  addProfile(profile: SurfaceProfile): void {
    this.profiles.add(profile);
  }

  saveProfile(profile: SurfaceProfile): void {
    this.profiles.add(profile);
  }

  deleteProfile(id: string): boolean {
    return this.profiles.delete(id);
  }
}
