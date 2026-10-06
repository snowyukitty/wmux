import path from 'node:path';
import { cliVersionSupport, newerCliVersionWarning } from '../../../shared/tokenUsage/capabilities';
import type { HookCostHint, ProviderInventory, SurfaceItem, SurfaceSource } from '../../../shared/tokenUsage/surfaceTypes';
import {
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

export async function readAgyInventory(deps: InventoryDeps): Promise<ProviderInventory> {
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

  const cliVersion = await queryCliVersion('agy', deps.run);
  const support = cliVersionSupport('agy', cliVersion);
  const versionSupported = support !== 'unsupported';
  if (support === 'newer' && cliVersion) warnings.push(newerCliVersionWarning('agy', cliVersion));
  const writable = versionSupported;

  // 1. MCP servers
  const mcpConfigs: Array<{ filePath: string; isProject: boolean }> = [
    { filePath: path.join(deps.homeDir, '.gemini', 'config', 'mcp_config.json'), isProject: false },
  ];
  if (deps.projectDir) {
    mcpConfigs.push({
      filePath: path.join(deps.projectDir, '.agents', 'mcp_config.json'),
      isProject: true,
    });
  }

  let hasMcpServers = false;
  const wmuxDeclarations: WmuxServerDeclaration[] = [];

  for (const { filePath, isProject } of mcpConfigs) {
    const content = await safeReadFile(filePath, deps, warnings);
    if (!content) continue;
    const parsed = safeParseJson<Record<string, unknown>>(filePath, content, warnings);
    if (!parsed || typeof parsed !== 'object') continue;

    const servers = parsed.mcpServers;
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      for (const [serverName, rawConf] of Object.entries(servers)) {
        hasMcpServers = true;
        const conf = rawConf && typeof rawConf === 'object' ? (rawConf as Record<string, unknown>) : {};
        const isWmux = serverName === 'wmux';
        const source: SurfaceSource = isWmux ? 'wmux' : isProject ? 'project' : 'user';
        const enabled = conf.disabled !== true;

        const serverItem = makeItem({
          provider: 'agy',
          kind: 'mcp-server',
          name: serverName,
          source,
          enabled,
          effect: 'removes',
          toggleable: true,
          originPath: filePath,
          wmuxRequired: isWmux,
        });
        addItem(serverItem);

        if (!isWmux && Array.isArray(conf.disabledTools)) {
          for (const tool of conf.disabledTools) {
            if (typeof tool === 'string') {
              addItem(
                makeItem({
                  provider: 'agy',
                  kind: 'mcp-tool',
                  name: tool,
                  parent: serverName,
                  source,
                  enabled: false,
                  effect: 'removes',
                  toggleable: true,
                  originPath: filePath,
                  wmuxRequired: false,
                }),
              );
            }
          }
        }

        if (isWmux) {
          const disabledTools = Array.isArray(conf.disabledTools)
            ? (conf.disabledTools as unknown[]).filter((x): x is string => typeof x === 'string')
            : [];
          wmuxDeclarations.push({
            source: isProject ? 'project' : 'user',
            serverItem,
            disabledNames: new Set<string>(disabledTools),
            originPath: filePath,
          });
        }
      }
    }
  }

  const effectiveWmux = resolveEffectiveWmuxServer(wmuxDeclarations);
  if (effectiveWmux) {
    if (effectiveWmux.warning) {
      warnings.push(effectiveWmux.warning);
    }
    const toolItems = wmuxToolItems('agy', effectiveWmux.effective.serverItem, effectiveWmux.effective.disabledNames, deps);
    for (const toolItem of toolItems) {
      if (!seenItemIds.has(toolItem.id)) {
        addItem(toolItem);
      }
    }
  }

  if (hasMcpServers) {
    warnings.push('Full MCP tool list requires live tools/list (config only records tool overrides).');
  }

  // 2. Skills: read skills.json for exclusions
  const excludeList = new Set<string>();
  const skillsJsonPaths = [
    path.join(deps.homeDir, '.gemini', 'config', 'skills.json'),
  ];
  if (deps.projectDir) {
    skillsJsonPaths.push(path.join(deps.projectDir, '.agents', 'skills.json'));
  }

  for (const sjp of skillsJsonPaths) {
    const content = await safeReadFile(sjp, deps, warnings);
    if (!content) continue;
    const parsed = safeParseJson<Record<string, unknown>>(sjp, content, warnings);
    if (!parsed) continue;

    if (Array.isArray(parsed.exclude)) {
      for (const ex of parsed.exclude) {
        if (typeof ex === 'string') excludeList.add(ex);
      }
    }
    if (Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries) {
        if (entry && typeof entry === 'object' && Array.isArray((entry as Record<string, unknown>).exclude)) {
          for (const ex of (entry as Record<string, unknown>).exclude as unknown[]) {
            if (typeof ex === 'string') excludeList.add(ex);
          }
        }
      }
    }
  }

  // 2. Skills
  // 2a. User and project skills
  const skillRoots: Array<{ dirPath: string; source: SurfaceSource }> = [
    { dirPath: path.join(deps.homeDir, '.gemini', 'config', 'skills'), source: 'user' },
    { dirPath: path.join(deps.homeDir, '.gemini', 'antigravity-cli', 'skills'), source: 'user' },
  ];
  if (deps.projectDir) {
    skillRoots.push({
      dirPath: path.join(deps.projectDir, '.agents', 'skills'),
      source: 'project',
    });
  }

  skillRoots.sort((a, b) => (LOCATION_SOURCE_ORDER[a.source] ?? 99) - (LOCATION_SOURCE_ORDER[b.source] ?? 99));

  for (const { dirPath, source } of skillRoots) {
    const sdirs = await safeReaddir(dirPath, deps);
    for (const sdir of sdirs) {
      const skillMdPath = path.join(dirPath, sdir, 'SKILL.md');
      const skillContent = await safeReadFile(skillMdPath, deps, warnings);
      if (skillContent === null) continue;

      const fm = parseSkillFrontmatter(skillContent);
      const skillName = fm.name || sdir;
      const desc = fm.description ?? '';
      const descChars = skillName.length + desc.length;
      const isExcluded = excludeList.has(sdir) || excludeList.has(skillName);

      addItem(
        makeItem({
          provider: 'agy',
          kind: 'skill',
          name: skillName,
          source,
          enabled: !isExcluded,
          effect: 'removes',
          toggleable: true,
          descriptionChars: descChars,
          originPath: skillMdPath,
        }),
      );
    }
  }

  // 3. Plugins
  const configJsonPath = path.join(deps.homeDir, '.gemini', 'config', 'config.json');
  const configContent = await safeReadFile(configJsonPath, deps, warnings);
  const parsedConfig = configContent
    ? safeParseJson<Record<string, unknown>>(configJsonPath, configContent, warnings)
    : null;
  const pluginsState = (parsedConfig?.plugins && typeof parsedConfig.plugins === 'object')
    ? (parsedConfig.plugins as Record<string, Record<string, unknown>>)
    : {};

  const pluginRoots: Array<{ dirPath: string; isProject: boolean }> = [
    { dirPath: path.join(deps.homeDir, '.gemini', 'config', 'plugins'), isProject: false },
    { dirPath: path.join(deps.homeDir, '.gemini', 'antigravity-cli', 'plugins'), isProject: false },
  ];
  if (deps.projectDir) {
    pluginRoots.push({
      dirPath: path.join(deps.projectDir, '.agents', 'plugins'),
      isProject: true,
    });
  }

  const pluginHookFiles: string[] = [];

  for (const { dirPath, isProject } of pluginRoots) {
    const pdirs = await safeReaddir(dirPath, deps);
    for (const pdir of pdirs) {
      const pluginJsonPath = path.join(dirPath, pdir, 'plugin.json');
      const pcontent = await safeReadFile(pluginJsonPath, deps, warnings);
      if (pcontent === null) continue;

      const pjson = safeParseJson<Record<string, unknown>>(pluginJsonPath, pcontent, warnings);
      const pluginName = (pjson?.name as string) || pdir;
      const stateEntry = pluginsState[pdir];

      let pluginEnabled = true;
      if (stateEntry && typeof stateEntry === 'object' && typeof stateEntry.enabled === 'boolean') {
        pluginEnabled = stateEntry.enabled;
      } else if (pjson && pjson.disabled === true) {
        pluginEnabled = false;
      }

      addItem(
        makeItem({
          provider: 'agy',
          kind: 'plugin',
          name: pluginName,
          source: isProject ? 'project' : 'user',
          enabled: pluginEnabled,
          effect: 'removes',
          toggleable: true,
          originPath: pluginJsonPath,
        }),
      );

      // Plugin skills (source: 'plugin')
      const pluginSkillsDir = path.join(dirPath, pdir, 'skills');
      const pluginSkillDirs = await safeReaddir(pluginSkillsDir, deps);
      for (const psdir of pluginSkillDirs) {
        const pskillMdPath = path.join(pluginSkillsDir, psdir, 'SKILL.md');
        const pskillContent = await safeReadFile(pskillMdPath, deps, warnings);
        if (pskillContent === null) continue;

        const fm = parseSkillFrontmatter(pskillContent);
        const skillName = fm.name || psdir;
        const desc = fm.description ?? '';
        const descChars = skillName.length + desc.length;
        const isExcluded = excludeList.has(psdir) || excludeList.has(skillName);

        addItem(
          makeItem({
            provider: 'agy',
            kind: 'skill',
            name: skillName,
            source: 'plugin',
            enabled: !isExcluded,
            effect: 'removes',
            toggleable: true,
            descriptionChars: descChars,
            originPath: pskillMdPath,
          }),
        );
      }

      // Collect plugin hooks
      const pluginHooksPath = path.join(dirPath, pdir, 'hooks.json');
      pluginHookFiles.push(pluginHooksPath);
    }
  }

  // 4. Built-in skills (source: 'builtin')
  const builtinSkillsDir = path.join(deps.homeDir, '.gemini', 'antigravity-cli', 'builtin', 'skills');
  const builtinSkillDirs = await safeReaddir(builtinSkillsDir, deps);

  for (const sdir of builtinSkillDirs) {
    const skillMdPath = path.join(builtinSkillsDir, sdir, 'SKILL.md');
    const skillContent = await safeReadFile(skillMdPath, deps, warnings);
    if (skillContent === null) continue;

    const fm = parseSkillFrontmatter(skillContent);
    const skillName = fm.name || sdir;
    const desc = fm.description ?? '';
    const descChars = skillName.length + desc.length;

    addItem(
      makeItem({
        provider: 'agy',
        kind: 'skill',
        name: skillName,
        source: 'builtin',
        enabled: true,
        effect: 'removes',
        toggleable: false,
        readOnlyReason: 'Built-in skills cannot be disabled',
        descriptionChars: descChars,
        originPath: skillMdPath,
      }),
    );
  }

  // 5. Hooks (user, project, plugin)
  const hookFiles: Array<{ filePath: string; source: SurfaceSource }> = [
    { filePath: path.join(deps.homeDir, '.gemini', 'config', 'hooks.json'), source: 'user' },
  ];
  if (deps.projectDir) {
    hookFiles.push({
      filePath: path.join(deps.projectDir, '.agents', 'hooks.json'),
      source: 'project',
    });
  }
  for (const phPath of pluginHookFiles) {
    hookFiles.push({
      filePath: phPath,
      source: 'plugin',
    });
  }

  for (const { filePath, source } of hookFiles) {
    await parseHooksFile(filePath, source, deps, warnings, addItem);
  }

  // If version is not supported, disable toggleability on all items
  if (!versionSupported) {
    for (const item of items) {
      if (item.toggleable) {
        item.toggleable = false;
        item.readOnlyReason = 'CLI version not supported (read-only)';
      }
    }
  }

  return {
    provider: 'agy',
    cliVersion,
    versionSupported,
    writable,
    items,
    warnings,
    scannedAtMs: deps.now ? deps.now() : Date.now(),
  };
}

async function parseHooksFile(
  filePath: string,
  defaultSource: SurfaceSource,
  deps: InventoryDeps,
  warnings: string[],
  addItem: (item: SurfaceItem) => void,
): Promise<void> {
  const content = await safeReadFile(filePath, deps, warnings);
  if (!content) return;

  const parsed = safeParseJson<Record<string, unknown>>(filePath, content, warnings);
  if (!parsed || typeof parsed !== 'object') return;

  const entries = (parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks))
    ? (parsed.hooks as Record<string, unknown>)
    : parsed;

  for (const [hookName, rawConf] of Object.entries(entries)) {
    if (!rawConf || typeof rawConf !== 'object') continue;
    const conf = rawConf as Record<string, unknown>;
    const event = typeof conf.event === 'string' ? conf.event : typeof conf.type === 'string' ? conf.type : null;

    let hookCost: HookCostHint = 'none';
    if (event === 'PreInvocation' || event === 'PostInvocation') {
      hookCost = 'injects-context';
    } else if (event === 'Stop') {
      hookCost = 'extra-turn';
    }

    const cmd = String(conf.command ?? conf.script ?? '');
    const isWmux = cmd.includes('wmux') || cmd.includes('.wmux');
    const source: SurfaceSource = isWmux ? 'wmux' : defaultSource;
    const enabled = conf.enabled !== false;

    addItem(
      makeItem({
        provider: 'agy',
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
