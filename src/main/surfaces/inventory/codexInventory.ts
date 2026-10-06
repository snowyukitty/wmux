import path from 'node:path';
import { cliVersionSupport, newerCliVersionWarning } from '../../../shared/tokenUsage/capabilities';
import type { HookCostHint, ProviderInventory, SurfaceItem, SurfaceSource } from '../../../shared/tokenUsage/surfaceTypes';
import {
  CODEX_HOOK_EVENTS,
  findCodexHooksBlock,
  isWmuxOwnedNotify,
} from '../../../shared/configIO';
import {
  normalizePath,
  parseSkillFrontmatter,
  queryCliVersion,
  safeParseJson,
  safeParseToml,
  safeReaddir,
  safeReadFile,
} from './helpers';
import { codexHookStateKey, normalizeDriveAndSeparators } from '../writers/codex/planEdits';
import {
  allocateUniqueItemId,
  LOCATION_SOURCE_ORDER,
  makeItem,
  type InventoryDeps,
} from './types';
import { listWmuxToolNames, resolveEffectiveWmuxServer, wmuxToolItems, type WmuxServerDeclaration } from './wmuxTools';

export async function readCodexInventory(deps: InventoryDeps): Promise<ProviderInventory> {
  const warnings: string[] = [];
  const items: SurfaceItem[] = [];
  const seenItemIds = new Set<string>();

  function addItem(item: SurfaceItem): void {
    const uniqueId = allocateUniqueItemId(seenItemIds, item.id, item.source);
    if (uniqueId !== item.id) {
      items.push({ ...item, id: uniqueId });
    } else {
      items.push(item);
    }
  }

  const cliVersion = await queryCliVersion('codex', deps.run);
  const support = cliVersionSupport('codex', cliVersion);
  const versionSupported = support !== 'unsupported';
  if (support === 'newer' && cliVersion) warnings.push(newerCliVersionWarning('codex', cliVersion));
  const writable = versionSupported;

  const configPath = path.join(deps.homeDir, '.codex', 'config.toml');
  const configDir = path.dirname(configPath);
  const configText = await safeReadFile(configPath, deps, warnings);
  const parsed = configText ? safeParseToml<Record<string, unknown>>(configPath, configText, warnings) : null;

  const disabledSkillPaths = new Set<string>();
  const hooksStateMap = new Map<string, boolean>();

  let hasMcpServers = false;
  const wmuxDeclarations: WmuxServerDeclaration[] = [];

  if (parsed && typeof parsed === 'object') {
    // 1. MCP servers
    const mcpServers = parsed.mcp_servers;
    if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
      for (const [serverName, rawConf] of Object.entries(mcpServers)) {
        hasMcpServers = true;
        const conf = rawConf && typeof rawConf === 'object' ? (rawConf as Record<string, unknown>) : {};
        const isWmux = serverName === 'wmux';
        const source: SurfaceSource = isWmux ? 'wmux' : 'user';
        const enabled = conf.enabled !== false;

        const serverItem = makeItem({
          provider: 'codex',
          kind: 'mcp-server',
          name: serverName,
          source,
          enabled,
          effect: 'removes',
          toggleable: true,
          originPath: configPath,
          wmuxRequired: isWmux,
        });
        addItem(serverItem);

        if (!isWmux && Array.isArray(conf.disabled_tools)) {
          for (const tool of conf.disabled_tools) {
            if (typeof tool === 'string') {
              addItem(
                makeItem({
                  provider: 'codex',
                  kind: 'mcp-tool',
                  name: tool,
                  parent: serverName,
                  source,
                  enabled: false,
                  effect: 'removes',
                  toggleable: true,
                  originPath: configPath,
                }),
              );
            }
          }
        }

        if (!isWmux && Array.isArray(conf.enabled_tools)) {
          for (const tool of conf.enabled_tools) {
            if (typeof tool === 'string') {
              addItem(
                makeItem({
                  provider: 'codex',
                  kind: 'mcp-tool',
                  name: tool,
                  parent: serverName,
                  source,
                  enabled: true,
                  effect: 'removes',
                  toggleable: true,
                  originPath: configPath,
                }),
              );
            }
          }
        }

        if (isWmux) {
          const disabledTools = Array.isArray(conf.disabled_tools)
            ? (conf.disabled_tools as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          const enabledTools = Array.isArray(conf.enabled_tools)
            ? (conf.enabled_tools as unknown[]).filter((x): x is string => typeof x === 'string')
            : null;

          const disabledSet = new Set<string>(disabledTools);
          if (enabledTools !== null) {
            const enabledSet = new Set(enabledTools);
            for (const name of listWmuxToolNames()) {
              if (!enabledSet.has(name)) {
                disabledSet.add(name);
              }
            }
          }

          wmuxDeclarations.push({
            source: 'user',
            serverItem,
            disabledNames: disabledSet,
            originPath: configPath,
          });
        }
      }
    }

    const effectiveWmux = resolveEffectiveWmuxServer(wmuxDeclarations);
    if (effectiveWmux) {
      if (effectiveWmux.warning) {
        warnings.push(effectiveWmux.warning);
      }
      const toolItems = wmuxToolItems('codex', effectiveWmux.effective.serverItem, effectiveWmux.effective.disabledNames, deps);
      for (const toolItem of toolItems) {
        if (!seenItemIds.has(toolItem.id)) {
          addItem(toolItem);
        }
      }
    }

    // 2. Plugins
    const plugins = parsed.plugins;
    if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
      for (const [pluginName, rawConf] of Object.entries(plugins)) {
        const conf = rawConf && typeof rawConf === 'object' ? (rawConf as Record<string, unknown>) : {};
        const enabled = conf.enabled !== false;

        addItem(
          makeItem({
            provider: 'codex',
            kind: 'plugin',
            name: pluginName,
            source: 'user',
            enabled,
            effect: 'removes',
            toggleable: true,
            originPath: configPath,
          }),
        );
      }
    }

    // 3. Skills disabled via [[skills.config]]
    const skillsTable = parsed.skills;
    const skillsConfig = (skillsTable && typeof skillsTable === 'object' && 'config' in skillsTable)
      ? (skillsTable as { config?: unknown }).config
      : parsed['skills.config'];

    if (Array.isArray(skillsConfig)) {
      for (const sc of skillsConfig) {
        if (sc && typeof sc === 'object' && typeof sc.path === 'string' && sc.enabled === false) {
          disabledSkillPaths.add(normalizePath(sc.path, configDir));
        }
      }
    }

    // 4. Hooks state in config.toml
    const hooksTable = parsed.hooks;
    const hooksState = (hooksTable && typeof hooksTable === 'object' && 'state' in hooksTable)
      ? (hooksTable as { state?: unknown }).state
      : parsed['hooks.state'];

    if (hooksState && typeof hooksState === 'object' && !Array.isArray(hooksState)) {
      for (const [stateKey, stateConf] of Object.entries(hooksState)) {
        if (stateConf && typeof stateConf === 'object') {
          const stateEnabled = (stateConf as Record<string, unknown>).enabled;
          if (typeof stateEnabled === 'boolean') {
            hooksStateMap.set(stateKey, stateEnabled);
          }
        }
      }
    }

    // 5. wmux managed hooks block in config.toml
    if (configText) {
      const block = findCodexHooksBlock(configText);
      if (block && !('unterminated' in block)) {
        for (const event of CODEX_HOOK_EVENTS) {
          const cost: HookCostHint = event === 'Stop' ? 'extra-turn' : 'injects-context';
          addItem(
            makeItem({
              provider: 'codex',
              kind: 'hook',
              name: `wmux-${event.toLowerCase()}`,
              source: 'wmux',
              enabled: true,
              effect: 'removes',
              toggleable: true,
              hookEvent: event,
              hookCost: cost,
              originPath: configPath,
              wmuxRequired: true,
            }),
          );
        }
      }
    }

    // 6. Notify in config.toml
    if (Array.isArray(parsed.notify)) {
      const isWmuxNotify = isWmuxOwnedNotify(parsed.notify as string[]);
      addItem(
        makeItem({
          provider: 'codex',
          kind: 'hook',
          name: 'codex-notify',
          source: isWmuxNotify ? 'wmux' : 'user',
          enabled: true,
          effect: 'removes',
          toggleable: true,
          hookEvent: 'TurnComplete',
          hookCost: 'none',
          originPath: configPath,
          wmuxRequired: isWmuxNotify,
        }),
      );
    }

    // 7. Features table
    const features = parsed.features;
    if (features && typeof features === 'object' && !Array.isArray(features)) {
      const featMap = features as Record<string, unknown>;
      if ('shell_tool' in featMap) {
        addItem(
          makeItem({
            provider: 'codex',
            kind: 'builtin-tool',
            name: 'shell_tool',
            source: 'builtin',
            enabled: featMap.shell_tool !== false,
            effect: 'removes',
            toggleable: true,
            originPath: configPath,
          }),
        );
      }
      if ('multi_agent' in featMap) {
        addItem(
          makeItem({
            provider: 'codex',
            kind: 'builtin-tool',
            name: 'multi_agent',
            source: 'builtin',
            enabled: featMap.multi_agent !== false,
            effect: 'removes',
            toggleable: true,
            originPath: configPath,
          }),
        );
      }
      if ('memories' in featMap) {
        addItem(
          makeItem({
            provider: 'codex',
            kind: 'builtin-tool',
            name: 'memories',
            source: 'builtin',
            enabled: featMap.memories !== false,
            effect: 'removes',
            toggleable: true,
            originPath: configPath,
          }),
        );
      }
      if ('web_search' in featMap) {
        const ws = featMap.web_search;
        const wsEnabled = ws !== 'disabled' && ws !== false;
        addItem(
          makeItem({
            provider: 'codex',
            kind: 'builtin-tool',
            name: 'web_search',
            source: 'builtin',
            enabled: wsEnabled,
            effect: 'removes',
            toggleable: true,
            originPath: configPath,
          }),
        );
      }
    }

    // 8. Context settings
    const contextKeys = [
      'model_verbosity',
      'tool_output_token_limit',
      'model_auto_compact_token_limit',
      'model_reasoning_summary',
    ];
    for (const ck of contextKeys) {
      if (ck in parsed) {
        addItem(
          makeItem({
            provider: 'codex',
            kind: 'context-setting',
            name: ck,
            source: 'user',
            // These are values, not switches, and the Codex writer has no edit for them.
            enabled: null,
            effect: 'removes',
            toggleable: false,
            readOnlyReason: 'Edit this value in config.toml.',
            originPath: configPath,
          }),
        );
      }
    }
  }

  // 9. Hooks file ~/.codex/hooks.json (and project .codex/hooks.json)
  const hookFiles: Array<{ filePath: string; isProject: boolean }> = [
    { filePath: path.join(deps.homeDir, '.codex', 'hooks.json'), isProject: false },
  ];
  if (deps.projectDir) {
    hookFiles.push({
      filePath: path.join(deps.projectDir, '.codex', 'hooks.json'),
      isProject: true,
    });
  }

  for (const { filePath, isProject } of hookFiles) {
    const content = await safeReadFile(filePath, deps, warnings);
    if (!content) continue;

    const hooksJson = safeParseJson<Record<string, unknown>>(filePath, content, warnings);
    if (!hooksJson || typeof hooksJson !== 'object') continue;

    const entries = (hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks))
      ? (hooksJson.hooks as Record<string, unknown>)
      : hooksJson;

    for (const [handlerIdx, [hookName, rawConf]] of Object.entries(entries).entries()) {
      if (!rawConf || typeof rawConf !== 'object') continue;
      if (Array.isArray(rawConf)) {
        // The grouped form (event -> groups[] -> hooks[]) has its own hooks.state keys, which the writer
        // does not build: list it, but read-only, rather than offer a switch that always fails.
        addItem(
          makeItem({
            provider: 'codex',
            kind: 'hook',
            name: hookName,
            source: isProject ? 'project' : 'user',
            enabled: null,
            effect: 'removes',
            toggleable: false,
            readOnlyReason: 'Grouped hooks.json entries can only be edited in the file.',
            hookEvent: hookName,
            originPath: filePath,
          }),
        );
        continue;
      }
      const conf = rawConf as Record<string, unknown>;
      const event = typeof conf.event === 'string' ? conf.event : typeof conf.type === 'string' ? conf.type : null;

      let hookCost: HookCostHint = 'none';
      if (event && ['UserPromptSubmit', 'SessionStart', 'SubagentStart', 'PreToolUse', 'PostToolUse'].includes(event)) {
        hookCost = 'injects-context';
      } else if (event && ['Stop', 'SubagentStop'].includes(event)) {
        hookCost = 'extra-turn';
      }

      const cmd = String(conf.command ?? conf.script ?? '');
      const isWmux = cmd.includes('wmux') || cmd.includes('.wmux');
      const source: SurfaceSource = isWmux ? 'wmux' : isProject ? 'project' : 'user';

      let enabled = conf.enabled !== false;
      // Match `hooks.state` on the exact key the writer uses; a loose match let one entry switch off
      // every hook with the same event in any file named hooks.json.
      if (event) {
        const exactKey = normalizeDriveAndSeparators(codexHookStateKey(filePath, event, handlerIdx));
        for (const [stateKey, stateVal] of hooksStateMap.entries()) {
          if (normalizeDriveAndSeparators(stateKey) === exactKey) enabled = stateVal;
        }
      }

      addItem(
        makeItem({
          provider: 'codex',
          kind: 'hook',
          name: hookName,
          source,
          enabled,
          effect: 'removes',
          toggleable: true,
          hookEvent: event,
          hookCost,
          originPath: filePath,
          wmuxRequired: isWmux,
        }),
      );
    }
  }

  // 10. Skills (sorted user, project, builtin)
  const skillRoots: Array<{ dirPath: string; source: SurfaceSource }> = [
    { dirPath: path.join(deps.homeDir, '.agents', 'skills'), source: 'user' },
  ];
  if (deps.projectDir) {
    skillRoots.push({
      dirPath: path.join(deps.projectDir, '.agents', 'skills'),
      source: 'project',
    });
  }
  skillRoots.push({
    dirPath: path.join(deps.homeDir, '.codex', 'skills', '.system'),
    source: 'builtin',
  });

  skillRoots.sort((a, b) => (LOCATION_SOURCE_ORDER[a.source] ?? 99) - (LOCATION_SOURCE_ORDER[b.source] ?? 99));

  for (const { dirPath, source } of skillRoots) {
    const isBuiltin = source === 'builtin';
    const sdirs = await safeReaddir(dirPath, deps);
    for (const sdir of sdirs) {
      const skillMdPath = path.join(dirPath, sdir, 'SKILL.md');
      const skillContent = await safeReadFile(skillMdPath, deps, warnings);
      if (skillContent === null) continue;

      const fm = parseSkillFrontmatter(skillContent);
      const skillName = fm.name || sdir;
      const desc = fm.description ?? '';
      const descChars = skillName.length + desc.length;

      const normSkillPath = normalizePath(skillMdPath);
      const normDir = normalizePath(path.dirname(skillMdPath));
      const isDisabled =
        !isBuiltin &&
        (disabledSkillPaths.has(normSkillPath) || disabledSkillPaths.has(normDir));

      addItem(
        makeItem({
          provider: 'codex',
          kind: 'skill',
          name: skillName,
          source,
          enabled: isBuiltin ? true : !isDisabled,
          effect: 'removes',
          toggleable: !isBuiltin,
          readOnlyReason: isBuiltin ? 'Built-in skills cannot be disabled' : null,
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

  return {
    provider: 'codex',
    cliVersion,
    versionSupported,
    writable,
    items,
    warnings,
    scannedAtMs: deps.now ? deps.now() : Date.now(),
  };
}
