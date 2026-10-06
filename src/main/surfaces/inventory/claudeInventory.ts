import path from 'node:path';
import type { HookCostHint, ProviderInventory, SurfaceItem, SurfaceSource } from '../../../shared/tokenUsage/surfaceTypes';
import { SurfacesStore } from '../safeWrite';
import {
  hookFingerprint,
  hookItemId,
  normalizePath,
  parseSkillFrontmatter,
  queryCliVersion,
  safeParseJson,
  safeReaddir,
  safeReadFile,
} from './helpers';
import {
  allocateUniqueItemId,
  LOCATION_SOURCE_ORDER,
  makeItem,
  type InventoryDeps,
} from './types';
import { resolveEffectiveWmuxServer, wmuxToolItems, type WmuxServerDeclaration } from './wmuxTools';

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

/** `disable*` keys are inverted: `disableBundledSkills: true` means the feature is off. */
export function contextSettingEnabled(key: string, value: boolean): boolean {
  return key.startsWith('disable') ? !value : value;
}

interface LiveHookInfo {
  event: string;
  handler: Record<string, unknown>;
  groupMeta?: Record<string, unknown>;
  originPath: string;
}

export async function readClaudeInventory(deps: InventoryDeps): Promise<ProviderInventory> {
  const warnings: string[] = [];
  const items: SurfaceItem[] = [];
  const seenItemIds = new Set<string>();
  const liveHooks: LiveHookInfo[] = [];

  function addItem(item: SurfaceItem): void {
    const uniqueId = allocateUniqueItemId(seenItemIds, item.id, item.source);
    if (uniqueId !== item.id) {
      items.push({ ...item, id: uniqueId });
    } else {
      items.push(item);
    }
  }

  const cliVersion = await queryCliVersion('claude', deps.run);
  const versionSupported = cliVersion !== null;
  const writable = versionSupported;

  // 1. Settings files
  const settingsPaths = [
    path.join(deps.homeDir, '.claude', 'settings.json'),
    path.join(deps.homeDir, '.claude', 'settings.local.json'),
  ];
  if (deps.projectDir) {
    settingsPaths.push(path.join(deps.projectDir, '.claude', 'settings.json'));
    settingsPaths.push(path.join(deps.projectDir, '.claude', 'settings.local.json'));
  }

  const deniedMcpServers = new Set<string>();
  // Which settings file holds each deny or override, so a change is written back to that file.
  const deniedServerFile = new Map<string, string>();
  const toolDenyFile = new Map<string, string>();
  const skillOverrideFile = new Map<string, string>();
  const mcpToolDenies = new Map<string, Set<string>>(); // serverName -> Set<toolName>
  const skillOverrides = new Map<string, string>();
  let disableAllHooks = false;
  let hasMcpServers = false;

  for (const sp of settingsPaths) {
    const content = await safeReadFile(sp, deps, warnings);
    if (!content) continue;

    const parsed = safeParseJson<Record<string, unknown>>(sp, content, warnings);
    if (!parsed || typeof parsed !== 'object') continue;

    if (parsed.disableAllHooks === true) {
      disableAllHooks = true;
    }

    // deniedMcpServers
    if (Array.isArray(parsed.deniedMcpServers)) {
      for (const d of parsed.deniedMcpServers) {
        if (d && typeof d === 'object' && typeof (d as { serverName?: unknown }).serverName === 'string') {
          deniedMcpServers.add((d as { serverName: string }).serverName);
          deniedServerFile.set((d as { serverName: string }).serverName, sp);
        }
      }
    }

    // permissions.deny
    const permissions = parsed.permissions;
    if (permissions && typeof permissions === 'object') {
      const deny = (permissions as { deny?: unknown }).deny;
      if (Array.isArray(deny)) {
        for (const item of deny) {
          if (typeof item !== 'string') continue;
          const mcpMatch = /^mcp__([a-zA-Z0-9_-]+)__(.+)$/.exec(item);
          if (mcpMatch) {
            const server = mcpMatch[1];
            const tool = mcpMatch[2];
            let set = mcpToolDenies.get(server);
            if (!set) {
              set = new Set<string>();
              mcpToolDenies.set(server, set);
            }
            set.add(tool);
            toolDenyFile.set(`${server}/${tool}`, sp);
          } else {
            // Bare tool denial
            addItem(
              makeItem({
                provider: 'claude',
                kind: 'builtin-tool',
                name: item,
                source: 'builtin',
                enabled: false,
                effect: 'removes',
                toggleable: true,
                originPath: sp,
              }),
            );
          }
        }
      }
    }

    // enabledPlugins
    const plugins = parsed.enabledPlugins;
    if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
      for (const [pluginName, val] of Object.entries(plugins)) {
        addItem(
          makeItem({
            provider: 'claude',
            kind: 'plugin',
            name: pluginName,
            source: 'user',
            enabled: val !== false,
            effect: 'removes',
            toggleable: true,
            originPath: sp,
          }),
        );
      }
    }

    // skillOverrides
    const so = parsed.skillOverrides;
    if (so && typeof so === 'object' && !Array.isArray(so)) {
      for (const [k, v] of Object.entries(so)) {
        if (typeof v === 'string') {
          skillOverrides.set(k, v);
          skillOverrideFile.set(k, sp);
        }
      }
    }

    // Context settings
    const contextKeys = [
      'autoMemoryEnabled',
      'claudeMdExcludes',
      'skillListingBudgetFraction',
      'skillListingMaxDescChars',
      'autoCompactEnabled',
      'disableBundledSkills',
    ];
    for (const ck of contextKeys) {
      if (!(ck in parsed)) continue;
      const value = parsed[ck];
      // Only booleans can be switched: a number or list has no "off" value to write and restore.
      const isBoolean = typeof value === 'boolean';
      addItem(
        makeItem({
          provider: 'claude',
          kind: 'context-setting',
          name: ck,
          source: 'user',
          enabled: isBoolean ? contextSettingEnabled(ck, value) : null,
          effect: 'removes',
          toggleable: isBoolean,
          readOnlyReason: isBoolean ? null : 'Only on/off settings can be switched here; edit this value in settings.json.',
          originPath: sp,
        }),
      );
    }

    // Hooks in settings.json
    const hooks = parsed.hooks;
    if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
      for (const [event, eventHooks] of Object.entries(hooks)) {
        const hookList: unknown[] = Array.isArray(eventHooks) ? eventHooks : [eventHooks];
        for (const hookDef of hookList) {
          if (!hookDef || typeof hookDef !== 'object') continue;
          const groupOrHandler = hookDef as Record<string, unknown>;
          if (Array.isArray(groupOrHandler.hooks)) {
            const groupMeta: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(groupOrHandler)) {
              if (k !== 'hooks') groupMeta[k] = v;
            }
            for (const item of groupOrHandler.hooks) {
              if (!item || typeof item !== 'object') continue;
              const h = item as Record<string, unknown>;
              liveHooks.push({ event, handler: h, groupMeta, originPath: sp });
              addLiveHookItem(event, h, sp, groupMeta);
            }
          } else {
            const h = groupOrHandler;
            liveHooks.push({ event, handler: h, originPath: sp });
            addLiveHookItem(event, h, sp);
          }
        }
      }
    }
  }

  function addLiveHookItem(
    event: string,
    h: Record<string, unknown>,
    originPath: string,
    groupMeta?: Record<string, unknown>,
  ): void {
    const type = typeof h.type === 'string' ? h.type : 'command';
    let hookCost: HookCostHint = 'none';
    if (type === 'prompt' || type === 'agent') {
      hookCost = 'calls-model';
    } else if (event === 'Stop' || event === 'SubagentStop') {
      hookCost = 'extra-turn';
    } else if (['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion'].includes(event)) {
      hookCost = 'injects-context';
    }

    const cmd = String(h.command ?? h.prompt ?? h.script ?? '');
    const isWmux = cmd.includes('wmux') || cmd.includes('.wmux');
    const isManaged = h.managed === true;
    const hookName = (typeof h.name === 'string' && h.name) || `${event}-${type}`;
    const isProject = deps.projectDir ? normalizePath(originPath).startsWith(normalizePath(deps.projectDir)) : false;
    const source: SurfaceSource = isWmux ? 'wmux' : isManaged ? 'managed' : isProject ? 'project' : 'user';

    const fingerprint = hookFingerprint(event, groupMeta, h);
    addItem({
      ...makeItem({
        provider: 'claude',
        kind: 'hook',
        name: hookName,
        source,
        enabled: !disableAllHooks,
        effect: 'removes',
        toggleable: !isManaged,
        readOnlyReason: isManaged ? 'Managed hooks cannot be toggled' : null,
        hookEvent: event,
        hookCost,
        hookFingerprint: fingerprint,
        originPath,
        wmuxRequired: isWmux,
      }),
      id: hookItemId(hookName, originPath, fingerprint),
    });
  }

  // 1b. Load removed hooks from surfaces.json store read-only
  const storePath = deps.surfacesStorePath ?? path.join(deps.homeDir, '.wmux', 'surfaces.json');
  const store = new SurfacesStore(storePath);
  try {
    store.load();
  } catch {
    warnings.push('The surfaces store file is corrupt and could not be read.');
  }

  for (const w of store.warnings) {
    let msg: string;
    if (w.startsWith('Corrupt surfaces store')) {
      msg = 'The surfaces store file is corrupt and could not be read.';
    } else if (w.startsWith('Unknown or unsupported surfaces store version')) {
      msg = 'The surfaces store has an unsupported or newer version.';
    } else {
      msg = 'The surfaces store could not be read.';
    }
    if (!warnings.includes(msg)) {
      warnings.push(msg);
    }
  }

  const liveItemsCount = items.length;
  try {
    const rawHooksStore = (store as unknown as { removedHooksStore?: Record<string, unknown> }).removedHooksStore;
    const rawClaude = rawHooksStore?.claude;
    if (rawClaude !== undefined && !Array.isArray(rawClaude)) {
      throw new Error('removedHooks.claude is not an array');
    }

    const removedHooks = store.removedHooks.list('claude');
    let hasInvalidEntries = false;

    for (const rawEntry of removedHooks) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        hasInvalidEntries = true;
        continue;
      }

      const entry = rawEntry as unknown as Record<string, unknown>;

      if (typeof entry.id !== 'string' || entry.id.trim() === '') {
        hasInvalidEntries = true;
        continue;
      }

      if (entry.originPath !== undefined && entry.originPath !== null && typeof entry.originPath !== 'string') {
        hasInvalidEntries = true;
        continue;
      }

      if (!entry.definition || typeof entry.definition !== 'object' || Array.isArray(entry.definition)) {
        hasInvalidEntries = true;
        continue;
      }

      if (seenItemIds.has(entry.id) || items.some((i) => i.id === entry.id)) {
        continue;
      }

      const def = entry.definition as Record<string, unknown>;
      let cleanHandler: Record<string, unknown>;
      if (def.handler && typeof def.handler === 'object' && !Array.isArray(def.handler)) {
        cleanHandler = def.handler as Record<string, unknown>;
      } else {
        const fallback: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(def)) {
          if (k !== 'event' && k !== 'groupMeta') {
            fallback[k] = v;
          }
        }
        cleanHandler = fallback;
      }

      const event = typeof def.event === 'string' ? def.event : 'PreToolUse';
      const groupMeta = def.groupMeta && typeof def.groupMeta === 'object' && !Array.isArray(def.groupMeta)
        ? (def.groupMeta as Record<string, unknown>)
        : undefined;

      const originPathStr = typeof entry.originPath === 'string' && entry.originPath.trim().length > 0
        ? entry.originPath
        : null;

      const alreadyPresentInFile = liveHooks.some((live) => {
        if (live.event !== event) return false;
        if (originPathStr && normalizePath(live.originPath) !== normalizePath(originPathStr)) {
          return false;
        }
        if (!deepEqual(live.handler, cleanHandler)) return false;
        if (groupMeta !== undefined) {
          if (!live.groupMeta || !deepEqual(live.groupMeta, groupMeta)) return false;
        } else {
          if (live.groupMeta !== undefined) return false;
        }
        return true;
      });

      if (alreadyPresentInFile) {
        continue;
      }

      const type = typeof cleanHandler.type === 'string' ? cleanHandler.type : 'command';
      let hookCost: HookCostHint = 'none';
      if (type === 'prompt' || type === 'agent') {
        hookCost = 'calls-model';
      } else if (event === 'Stop' || event === 'SubagentStop') {
        hookCost = 'extra-turn';
      } else if (['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion'].includes(event)) {
        hookCost = 'injects-context';
      }

      const cmd = String(cleanHandler.command ?? cleanHandler.prompt ?? cleanHandler.script ?? '');
      const isWmux = cmd.includes('wmux') || cmd.includes('.wmux');
      const isManaged = cleanHandler.managed === true;
      const hookName = (typeof cleanHandler.name === 'string' && cleanHandler.name) || `${event}-${type}`;
      const isProject = deps.projectDir && originPathStr
        ? normalizePath(originPathStr).startsWith(normalizePath(deps.projectDir))
        : false;
      const source: SurfaceSource = isWmux ? 'wmux' : isManaged ? 'managed' : isProject ? 'project' : 'user';

      const toggleable = versionSupported && !isManaged;
      const readOnlyReason = isManaged
        ? 'Managed hooks cannot be toggled'
        : (!versionSupported ? 'CLI version not supported (read-only)' : null);

      seenItemIds.add(entry.id);
      items.push({
        id: entry.id,
        provider: 'claude',
        kind: 'hook',
        name: hookName,
        parent: null,
        source,
        enabled: false,
        effect: 'removes',
        toggleable,
        readOnlyReason,
        hookEvent: event,
        hookCost,
        hookFingerprint: hookFingerprint(event, groupMeta, cleanHandler),
        descriptionChars: null,
        originPath: originPathStr,
        wmuxRequired: isWmux,
      });
    }

    if (hasInvalidEntries) {
      const msg = 'One or more removed hooks in the surfaces store are invalid and were skipped.';
      if (!warnings.includes(msg)) {
        warnings.push(msg);
      }
    }
  } catch {
    items.length = liveItemsCount;
    seenItemIds.clear();
    for (const it of items) {
      seenItemIds.add(it.id);
    }
    const msg = 'The surfaces store could not be read.';
    if (!warnings.includes(msg)) {
      warnings.push(msg);
    }
  }

  // 2. ~/.claude.json for MCP servers
  const claudeJsonPath = path.join(deps.homeDir, '.claude.json');
  const claudeJsonContent = await safeReadFile(claudeJsonPath, deps, warnings);
  const parsedClaudeJson = claudeJsonContent
    ? safeParseJson<Record<string, unknown>>(claudeJsonPath, claudeJsonContent, warnings)
    : null;

  const projectDisabledMcpServers = new Set<string>();
  if (parsedClaudeJson && deps.projectDir && parsedClaudeJson.projects && typeof parsedClaudeJson.projects === 'object') {
    const normProjDir = normalizePath(deps.projectDir);
    for (const [projPath, projConf] of Object.entries(parsedClaudeJson.projects as Record<string, unknown>)) {
      if (normalizePath(projPath) === normProjDir && projConf && typeof projConf === 'object') {
        const disabled = (projConf as { disabledMcpServers?: unknown }).disabledMcpServers;
        if (Array.isArray(disabled)) {
          for (const s of disabled) {
            if (typeof s === 'string') projectDisabledMcpServers.add(s);
          }
        }
      }
    }
  }

  const wmuxDeclarations: WmuxServerDeclaration[] = [];
  const addMcpServerWithTools = (
    serverName: string,
    source: SurfaceSource,
    originPath: string,
    disabledByConfig = false,
  ) => {
    hasMcpServers = true;
    const isWmux = serverName === 'wmux';
    const isDenied = deniedMcpServers.has(serverName) || projectDisabledMcpServers.has(serverName) || disabledByConfig;
    const finalSource: SurfaceSource = isWmux ? 'wmux' : source;

    const serverItem = makeItem({
      provider: 'claude',
      kind: 'mcp-server',
      name: serverName,
      source: finalSource,
      enabled: !isDenied,
      effect: 'removes',
      toggleable: true,
      originPath,
      wmuxRequired: isWmux,
    });
    addItem(serverItem);

    const deniedTools = mcpToolDenies.get(serverName);
    if (!isWmux && deniedTools) {
      for (const tool of deniedTools) {
        addItem(
          makeItem({
            provider: 'claude',
            kind: 'mcp-tool',
            name: tool,
            parent: serverName,
            source: finalSource,
            enabled: false,
            effect: 'removes',
            toggleable: true,
            originPath,
          }),
        );
      }
    }

    if (isWmux) {
      wmuxDeclarations.push({
        source: source as 'project' | 'user' | 'plugin',
        serverItem,
        disabledNames: deniedTools ?? new Set<string>(),
        originPath,
      });
    }
  };

  if (parsedClaudeJson && typeof parsedClaudeJson === 'object') {
    const servers = parsedClaudeJson.mcpServers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      for (const serverName of Object.keys(servers)) {
        addMcpServerWithTools(serverName, 'user', claudeJsonPath);
      }
    }

    if (deps.projectDir && parsedClaudeJson.projects && typeof parsedClaudeJson.projects === 'object') {
      const normProjDir = normalizePath(deps.projectDir);
      for (const [projPath, projConf] of Object.entries(parsedClaudeJson.projects as Record<string, unknown>)) {
        if (normalizePath(projPath) === normProjDir && projConf && typeof projConf === 'object') {
          const projServers = (projConf as { mcpServers?: unknown }).mcpServers;
          if (projServers && typeof projServers === 'object' && !Array.isArray(projServers)) {
            for (const serverName of Object.keys(projServers)) {
              addMcpServerWithTools(serverName, 'project', claudeJsonPath);
            }
          }
        }
      }
    }
  }

  // 3. Project .mcp.json
  if (deps.projectDir) {
    const projectMcpJsonPath = path.join(deps.projectDir, '.mcp.json');
    const pcontent = await safeReadFile(projectMcpJsonPath, deps, warnings);
    if (pcontent) {
      const parsedPMcp = safeParseJson<Record<string, unknown>>(projectMcpJsonPath, pcontent, warnings);
      if (parsedPMcp && parsedPMcp.mcpServers && typeof parsedPMcp.mcpServers === 'object' && !Array.isArray(parsedPMcp.mcpServers)) {
        for (const serverName of Object.keys(parsedPMcp.mcpServers)) {
          addMcpServerWithTools(serverName, 'project', projectMcpJsonPath);
        }
      }
    }
  }

  const effectiveWmux = resolveEffectiveWmuxServer(wmuxDeclarations);
  if (effectiveWmux) {
    if (effectiveWmux.warning) {
      warnings.push(effectiveWmux.warning);
    }
    const wmuxTools = wmuxToolItems('claude', effectiveWmux.effective.serverItem, effectiveWmux.effective.disabledNames, deps);
    for (const toolItem of wmuxTools) {
      if (!seenItemIds.has(toolItem.id)) {
        addItem(toolItem);
      }
    }
  }

  // 4. Skills (user, project, plugin)
  // 4a. User skills in ~/.claude/skills
  const userSkillsDir = path.join(deps.homeDir, '.claude', 'skills');
  const userSkillDirs = await safeReaddir(userSkillsDir, deps);
  for (const sdir of userSkillDirs) {
    const skillMdPath = path.join(userSkillsDir, sdir, 'SKILL.md');
    const skillContent = await safeReadFile(skillMdPath, deps, warnings);
    if (skillContent === null) continue;

    const fm = parseSkillFrontmatter(skillContent);
    const skillName = fm.name || sdir;
    const desc = fm.description ?? '';
    const descChars = skillName.length + desc.length;

    const override = skillOverrides.get(skillName) ?? skillOverrides.get(sdir);
    const enabled = override !== 'off';

    addItem(
      makeItem({
        provider: 'claude',
        kind: 'skill',
        name: skillName,
        source: 'user',
        enabled,
        effect: 'removes',
        toggleable: true,
        descriptionChars: descChars,
        originPath: skillMdPath,
      }),
    );
  }

  // 4b. Project skills in <project>/.claude/skills
  if (deps.projectDir) {
    const projectSkillsDir = path.join(deps.projectDir, '.claude', 'skills');
    const projectSkillDirs = await safeReaddir(projectSkillsDir, deps);
    for (const sdir of projectSkillDirs) {
      const skillMdPath = path.join(projectSkillsDir, sdir, 'SKILL.md');
      const skillContent = await safeReadFile(skillMdPath, deps, warnings);
      if (skillContent === null) continue;

      const fm = parseSkillFrontmatter(skillContent);
      const skillName = fm.name || sdir;
      const desc = fm.description ?? '';
      const descChars = skillName.length + desc.length;

      const override = skillOverrides.get(skillName) ?? skillOverrides.get(sdir);
      const enabled = override !== 'off';

      addItem(
        makeItem({
          provider: 'claude',
          kind: 'skill',
          name: skillName,
          source: 'project',
          enabled,
          effect: 'removes',
          toggleable: true,
          descriptionChars: descChars,
          originPath: skillMdPath,
        }),
      );
    }
  }

  // 4c. Plugin skills
  const pluginSkillsBaseDir = path.join(deps.homeDir, '.claude', 'plugins');
  const pluginDirs = await safeReaddir(pluginSkillsBaseDir, deps);
  for (const pdir of pluginDirs) {
    const pskillsDir = path.join(pluginSkillsBaseDir, pdir, 'skills');
    const pskills = await safeReaddir(pskillsDir, deps);
    for (const psdir of pskills) {
      const skillMdPath = path.join(pskillsDir, psdir, 'SKILL.md');
      const skillContent = await safeReadFile(skillMdPath, deps, warnings);
      if (skillContent === null) continue;

      const fm = parseSkillFrontmatter(skillContent);
      const skillName = fm.name || psdir;
      const desc = fm.description ?? '';
      const descChars = skillName.length + desc.length;

      addItem(
        makeItem({
          provider: 'claude',
          kind: 'skill',
          name: skillName,
          source: 'plugin',
          enabled: true,
          effect: 'removes',
          toggleable: false,
          readOnlyReason: 'Plugin skills cannot be toggled in Claude Code',
          descriptionChars: descChars,
          originPath: skillMdPath,
        }),
      );
    }
  }

  if (hasMcpServers) {
    warnings.push('Full MCP tool list requires live tools/list (config only records tool overrides).');
  }

  if (!versionSupported) {
    for (const item of items) {
      if (item.toggleable) {
        item.toggleable = false;
        item.readOnlyReason = 'CLI version not supported (read-only)';
      }
    }
  }

  for (const item of items) {
    const file = item.kind === 'mcp-server' ? deniedServerFile.get(item.name)
      : item.kind === 'mcp-tool' ? toolDenyFile.get(`${item.parent}/${item.name}`)
        : item.kind === 'skill' ? skillOverrideFile.get(item.name) ?? (item.originPath ? skillOverrideFile.get(path.basename(path.dirname(item.originPath))) : undefined)
          : undefined;
    if (file) item.settingsPath = file;
  }

  return {
    provider: 'claude',
    cliVersion,
    versionSupported,
    writable,
    items,
    warnings,
    scannedAtMs: deps.now ? deps.now() : Date.now(),
  };
}
