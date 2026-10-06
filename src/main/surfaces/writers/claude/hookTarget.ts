import type { SurfaceItem } from '../../../../shared/tokenUsage/surfaceTypes';
import { hookFingerprint } from '../../inventory/helpers';
import { SurfacesStore } from '../../safeWrite';
import type { ResolvedChange } from '../types';
import type { ClaudeHookHandler, ClaudeMatcherGroup, ClaudeRemovedHookDefinition } from './types';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

function matcherGroupsEqual(grp: Record<string, unknown>, meta: Record<string, unknown>): boolean {
  const grpMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(grp)) {
    if (k !== 'hooks') {
      grpMeta[k] = v;
    }
  }
  return deepEqual(grpMeta, meta);
}

function handlerMatchesItem(
  h: ClaudeHookHandler,
  item: SurfaceItem,
  event: string,
  groupMeta: Record<string, unknown> | undefined,
): boolean {
  // Unnamed handlers all share the name `<event>-<type>`, so a name alone can point at the wrong one.
  if (item.hookFingerprint) return hookFingerprint(event, groupMeta, h) === item.hookFingerprint;
  const hType = typeof h.type === 'string' ? h.type : 'command';
  const hName = (typeof h.name === 'string' && h.name) || `${event}-${hType}`;
  return hName === item.name;
}

interface HookDisableMatch {
  change: ResolvedChange;
  event: string;
  groupIdx: number;
  handlerIdx: number | null;
  handler: ClaudeHookHandler;
  groupMeta?: Record<string, unknown>;
}

export function applyHookChangesToRoot(
  root: Record<string, unknown>,
  changes: ResolvedChange[],
  targetPath: string,
  store: SurfacesStore,
): void {
  const disableChanges = changes.filter((c) => !c.enabled);
  const enableChanges = changes.filter((c) => c.enabled);

  if (disableChanges.length > 0) {
    const hooksObj = root.hooks as Record<string, unknown> | undefined;
    if (!hooksObj || typeof hooksObj !== 'object') {
      throw new Error('Hook not found: hooks configuration missing');
    }

    const matches: HookDisableMatch[] = [];

    for (const change of disableChanges) {
      const event = change.item.hookEvent;
      if (!event || !Array.isArray(hooksObj[event])) {
        throw new Error('Hook not found in event configuration');
      }

      const eventList = hooksObj[event] as unknown[];
      const found: HookDisableMatch[] = [];

      for (let gIdx = 0; gIdx < eventList.length; gIdx++) {
        const groupOrHandler = eventList[gIdx] as Record<string, unknown>;
        if (groupOrHandler && Array.isArray(groupOrHandler.hooks)) {
          const groupMeta: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(groupOrHandler)) {
            if (k !== 'hooks') groupMeta[k] = v;
          }
          const hooksArray = groupOrHandler.hooks as ClaudeHookHandler[];
          for (let hIdx = 0; hIdx < hooksArray.length; hIdx++) {
            if (handlerMatchesItem(hooksArray[hIdx], change.item, event, groupMeta)) {
              found.push({
                change,
                event,
                groupIdx: gIdx,
                handlerIdx: hIdx,
                handler: hooksArray[hIdx],
                groupMeta,
              });
            }
          }
        } else if (groupOrHandler && typeof groupOrHandler === 'object') {
          if (handlerMatchesItem(groupOrHandler as ClaudeHookHandler, change.item, event, undefined)) {
            found.push({
              change,
              event,
              groupIdx: gIdx,
              handlerIdx: null,
              handler: groupOrHandler as ClaudeHookHandler,
            });
          }
        }
      }

      if (found.length === 0) {
        throw new Error('Hook not found in configuration');
      }
      if (found.length > 1) {
        // Removing the first of several matches could remove a hook the user (or wmux) still needs.
        throw new Error('More than one hook matches; edit this hook in the settings file by hand.');
      }
      matches.push(found[0]);
    }

    // Persist removed hooks in store before modifying config. An id that already holds a different
    // hook must not be overwritten: that would lose the first hook's saved definition.
    for (const match of matches) {
      const existing = store.removedHooks.get('claude', match.change.item.id);
      if (existing) {
        const def = existing.definition as Record<string, unknown>;
        const stored = def.handler && typeof def.handler === 'object'
          ? hookFingerprint(String(def.event ?? ''), def.groupMeta as Record<string, unknown> | undefined, def.handler as Record<string, unknown>)
          : null;
        if (stored !== hookFingerprint(match.event, match.groupMeta, match.handler)) {
          throw new Error('More than one hook matches; edit this hook in the settings file by hand.');
        }
      }
    }
    for (const match of matches) {
      const definition: ClaudeRemovedHookDefinition = {
        event: match.event,
        groupMeta: match.groupMeta,
        handler: match.handler,
      };
      store.removedHooks.add('claude', {
        id: match.change.item.id,
        definition,
        originPath: targetPath,
      });
    }
    store.save();

    // Group matches by event and sort highest to lowest
    const byEvent = new Map<string, HookDisableMatch[]>();
    for (const m of matches) {
      const list = byEvent.get(m.event) ?? [];
      list.push(m);
      byEvent.set(m.event, list);
    }

    for (const [event, eventMatches] of byEvent.entries()) {
      const eventList = hooksObj[event] as unknown[];

      // Phase 1: Delete handlers within each group from highest handler index to lowest
      const byGroup = new Map<number, HookDisableMatch[]>();
      for (const m of eventMatches) {
        const list = byGroup.get(m.groupIdx) ?? [];
        list.push(m);
        byGroup.set(m.groupIdx, list);
      }

      for (const [groupIdx, groupMatches] of byGroup.entries()) {
        const group = eventList[groupIdx] as ClaudeMatcherGroup;
        if (group && Array.isArray(group.hooks)) {
          // Sort handler indices descending
          const handlerMatches = groupMatches
            .filter((m) => m.handlerIdx !== null)
            .sort((a, b) => (b.handlerIdx ?? 0) - (a.handlerIdx ?? 0));
          for (const hm of handlerMatches) {
            if (hm.handlerIdx !== null) {
              group.hooks.splice(hm.handlerIdx, 1);
            }
          }
        }
      }

      // Phase 2: Drop empty matcher groups or matched bare handlers from highest index to lowest
      for (let gIdx = eventList.length - 1; gIdx >= 0; gIdx--) {
        const item = eventList[gIdx] as Record<string, unknown>;
        if (item && Array.isArray(item.hooks)) {
          // Only a group this edit emptied; a group the user left empty stays as it was.
          const emptiedHere = eventMatches.some((m) => m.groupIdx === gIdx && m.handlerIdx !== null);
          if (item.hooks.length === 0 && emptiedHere) {
            eventList.splice(gIdx, 1);
          }
        } else if (item && typeof item === 'object') {
          // If this was a bare handler that was disabled
          const wasDisabledBare = eventMatches.some(
            (m) => m.groupIdx === gIdx && m.handlerIdx === null,
          );
          if (wasDisabledBare) {
            eventList.splice(gIdx, 1);
          }
        }
      }

      // Phase 3: Drop event key if array becomes empty
      if (eventList.length === 0) {
        delete hooksObj[event];
      }
    }

    if (Object.keys(hooksObj).length === 0) {
      delete root.hooks;
    }
  }

  if (enableChanges.length > 0) {
    for (const change of enableChanges) {
      const entry = store.removedHooks.get('claude', change.item.id);
      if (!entry) {
        throw new Error('Cannot enable hook: definition not found in store');
      }

      const def = entry.definition as Record<string, unknown>;
      let cleanHandler: ClaudeHookHandler;
      if (def.handler && typeof def.handler === 'object' && !Array.isArray(def.handler)) {
        cleanHandler = def.handler as ClaudeHookHandler;
      } else {
        const fallback: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(def)) {
          if (k !== 'event' && k !== 'groupMeta') {
            fallback[k] = v;
          }
        }
        cleanHandler = fallback;
      }

      const event = (def.event as string) || change.item.hookEvent || 'PreToolUse';
      const groupMeta = def.groupMeta as Record<string, unknown> | undefined;

      if (!root.hooks || typeof root.hooks !== 'object') {
        root.hooks = {};
      }
      const hooksObj = root.hooks as Record<string, unknown>;
      if (!Array.isArray(hooksObj[event])) {
        hooksObj[event] = [];
      }
      const eventList = hooksObj[event] as unknown[];

      if (groupMeta !== undefined) {
        const matchingGroups = eventList.filter(
          (g): g is ClaudeMatcherGroup =>
            typeof g === 'object' &&
            g !== null &&
            Array.isArray((g as ClaudeMatcherGroup).hooks) &&
            matcherGroupsEqual(g as Record<string, unknown>, groupMeta),
        );
        const alreadyExists = matchingGroups.some((g) =>
          g.hooks.some((h) => deepEqual(h, cleanHandler)),
        );
        if (alreadyExists) {
          continue;
        }

        if (matchingGroups.length > 0) {
          matchingGroups[0].hooks.push(cleanHandler);
        } else {
          const newGroup: ClaudeMatcherGroup = {
            ...groupMeta,
            hooks: [cleanHandler],
          };
          eventList.push(newGroup);
        }
      } else {
        const alreadyExists = eventList.some((h) => deepEqual(h, cleanHandler));
        if (alreadyExists) {
          continue;
        }
        eventList.push(cleanHandler);
      }
    }
  }
}
