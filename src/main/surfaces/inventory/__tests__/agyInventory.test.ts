import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readAgyInventory } from '../agyInventory';
import type { InventoryDeps } from '../types';

describe('readAgyInventory', () => {
  it('reads agy inventory with all required fixture scenarios', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-inventory-test-'));

    try {
      const geminiConfigDir = path.join(tempDir, '.gemini', 'config');
      const antigravityCliDir = path.join(tempDir, '.gemini', 'antigravity-cli');
      const builtinSkillsDir = path.join(antigravityCliDir, 'builtin', 'skills');
      const pluginsDir = path.join(geminiConfigDir, 'plugins');
      const skillsDir = path.join(geminiConfigDir, 'skills');

      await fs.mkdir(geminiConfigDir, { recursive: true });
      await fs.mkdir(builtinSkillsDir, { recursive: true });
      await fs.mkdir(pluginsDir, { recursive: true });
      await fs.mkdir(skillsDir, { recursive: true });

      // 1. MCP servers: one disabled, one with disabled tools, one wmux
      const mcpConfig = {
        mcpServers: {
          wmux: {
            command: 'node',
            args: ['wmux-mcp.js'],
          },
          'server-disabled': {
            command: 'node',
            args: ['server.js'],
            disabled: true,
          },
          'server-tools-disabled': {
            command: 'node',
            args: ['server2.js'],
            disabledTools: ['toolA'],
          },
        },
      };
      await fs.writeFile(
        path.join(geminiConfigDir, 'mcp_config.json'),
        JSON.stringify(mcpConfig),
        'utf8',
      );

      // 2. Skills: one disabled by exact name in exclude, one not disabled
      await fs.writeFile(
        path.join(geminiConfigDir, 'skills.json'),
        JSON.stringify({ exclude: ['disabled-skill'] }),
        'utf8',
      );

      const skill1Dir = path.join(skillsDir, 'disabled-skill');
      await fs.mkdir(skill1Dir, { recursive: true });
      await fs.writeFile(
        path.join(skill1Dir, 'SKILL.md'),
        '---\nname: disabled-skill\ndescription: Disabled skill description\n---\nBody',
        'utf8',
      );

      const skill2Dir = path.join(skillsDir, 'active-skill');
      await fs.mkdir(skill2Dir, { recursive: true });
      await fs.writeFile(
        path.join(skill2Dir, 'SKILL.md'),
        '---\nname: active-skill\ndescription: Active skill description\n---\nBody',
        'utf8',
      );

      // Built-in skill (in antigravity-cli/builtin/skills)
      const builtinSkillDir = path.join(builtinSkillsDir, 'builtin-skill');
      await fs.mkdir(builtinSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(builtinSkillDir, 'SKILL.md'),
        '---\nname: builtin-skill\ndescription: Built-in skill\n---\nBody',
        'utf8',
      );

      // 3. Plugins:
      // plugin-active (on disk, not listed by run command)
      const plugin1Dir = path.join(pluginsDir, 'plugin-active');
      await fs.mkdir(plugin1Dir, { recursive: true });
      await fs.writeFile(
        path.join(plugin1Dir, 'plugin.json'),
        JSON.stringify({ name: 'plugin-active' }),
        'utf8',
      );

      // plugin-disabled via config.json
      const plugin2Dir = path.join(pluginsDir, 'plugin-disabled');
      await fs.mkdir(plugin2Dir, { recursive: true });
      await fs.writeFile(
        path.join(plugin2Dir, 'plugin.json'),
        JSON.stringify({ name: 'plugin-disabled' }),
        'utf8',
      );

      await fs.writeFile(
        path.join(geminiConfigDir, 'config.json'),
        JSON.stringify({
          plugins: {
            'plugin-disabled': { enabled: false },
          },
        }),
        'utf8',
      );

      // 4. Hooks: with enabled:false, PreInvocation (injects-context), Stop (extra-turn), PreToolUse (none), wmux hook
      const hooksConfig = {
        'hook-disabled': {
          event: 'PreInvocation',
          command: 'node hook.js',
          enabled: false,
        },
        'hook-stop': {
          event: 'Stop',
          command: 'node stop.js',
          enabled: true,
        },
        'hook-tool': {
          event: 'PreToolUse',
          command: 'node tool.js',
          enabled: true,
        },
        'wmux-hook': {
          event: 'PostInvocation',
          command: 'node ~/.wmux/hooks/bridge.js',
          enabled: true,
        },
      };
      await fs.writeFile(
        path.join(geminiConfigDir, 'hooks.json'),
        JSON.stringify(hooksConfig),
        'utf8',
      );

      // 5. Injected run mock returning version 1.2.14, and simulating plugin list returning "No imported plugins"
      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async (cmd, args) => {
          if (cmd === 'agy' && args[0] === '--version') {
            return '1.2.14';
          }
          if (cmd === 'agy' && args[0] === 'plugin' && args[1] === 'list') {
            return 'No imported plugins';
          }
          throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
        },
      };

      const inventory = await readAgyInventory(deps);

      expect(inventory.provider).toBe('agy');
      expect(inventory.cliVersion).toBe('1.2.14');
      expect(inventory.versionSupported).toBe(true);
      expect(inventory.writable).toBe(true);

      // Check MCP servers
      const wmuxServer = inventory.items.find((i) => i.name === 'wmux' && i.kind === 'mcp-server');
      expect(wmuxServer).toBeDefined();
      expect(wmuxServer?.source).toBe('wmux');
      expect(wmuxServer?.wmuxRequired).toBe(true);
      expect(wmuxServer?.enabled).toBe(true);
      expect(wmuxServer?.toggleable).toBe(true);

      const disabledServer = inventory.items.find((i) => i.name === 'server-disabled' && i.kind === 'mcp-server');
      expect(disabledServer).toBeDefined();
      expect(disabledServer?.enabled).toBe(false);

      const toolsServer = inventory.items.find((i) => i.name === 'server-tools-disabled' && i.kind === 'mcp-server');
      expect(toolsServer?.enabled).toBe(true);

      const disabledTool = inventory.items.find((i) => i.name === 'toolA' && i.kind === 'mcp-tool');
      expect(disabledTool).toBeDefined();
      expect(disabledTool?.parent).toBe('server-tools-disabled');
      expect(disabledTool?.enabled).toBe(false);

      // Check skills
      const disabledSkill = inventory.items.find((i) => i.name === 'disabled-skill' && i.kind === 'skill');
      expect(disabledSkill).toBeDefined();
      expect(disabledSkill?.enabled).toBe(false);
      expect(disabledSkill?.toggleable).toBe(true);

      const activeSkill = inventory.items.find((i) => i.name === 'active-skill' && i.kind === 'skill');
      expect(activeSkill?.enabled).toBe(true);

      const builtinSkill = inventory.items.find((i) => i.name === 'builtin-skill' && i.kind === 'skill');
      expect(builtinSkill).toBeDefined();
      expect(builtinSkill?.source).toBe('builtin');
      expect(builtinSkill?.toggleable).toBe(false);
      expect(builtinSkill?.readOnlyReason).toBe('Built-in skills cannot be disabled');
      expect(builtinSkill?.enabled).toBe(true);

      // Check plugins (discovered on-disk despite run returning "No imported plugins")
      const pluginActive = inventory.items.find((i) => i.name === 'plugin-active' && i.kind === 'plugin');
      expect(pluginActive).toBeDefined();
      expect(pluginActive?.enabled).toBe(true);

      const pluginDisabled = inventory.items.find((i) => i.name === 'plugin-disabled' && i.kind === 'plugin');
      expect(pluginDisabled).toBeDefined();
      expect(pluginDisabled?.enabled).toBe(false);

      // Check hooks
      const hookDisabled = inventory.items.find((i) => i.name === 'hook-disabled' && i.kind === 'hook');
      expect(hookDisabled?.enabled).toBe(false);
      expect(hookDisabled?.hookCost).toBe('injects-context');

      const hookStop = inventory.items.find((i) => i.name === 'hook-stop' && i.kind === 'hook');
      expect(hookStop?.hookCost).toBe('extra-turn');

      const hookTool = inventory.items.find((i) => i.name === 'hook-tool' && i.kind === 'hook');
      expect(hookTool?.hookCost).toBe('none');

      const wmuxHook = inventory.items.find((i) => i.name === 'wmux-hook' && i.kind === 'hook');
      expect(wmuxHook?.source).toBe('wmux');
      expect(wmuxHook?.wmuxRequired).toBe(true);

      // MCP warning
      expect(inventory.warnings.some((w) => w.includes('Full MCP tool list requires live tools/list'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('handles malformed file by adding a warning and returning remaining items', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-malformed-test-'));

    try {
      const geminiConfigDir = path.join(tempDir, '.gemini', 'config');
      await fs.mkdir(geminiConfigDir, { recursive: true });

      // Valid mcp_config.json
      await fs.writeFile(
        path.join(geminiConfigDir, 'mcp_config.json'),
        JSON.stringify({ mcpServers: { test: { command: 'node' } } }),
        'utf8',
      );

      // Malformed hooks.json
      await fs.writeFile(path.join(geminiConfigDir, 'hooks.json'), 'not valid json {{{', 'utf8');

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '1.2.14',
      };

      const inventory = await readAgyInventory(deps);
      expect(inventory.items.some((i) => i.name === 'test')).toBe(true);
      expect(inventory.warnings.some((w) => w.includes('Failed to parse JSON'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('marks unsupported version as versionSupported:false and writable:false', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-version-test-'));

    try {
      const geminiConfigDir = path.join(tempDir, '.gemini', 'config');
      await fs.mkdir(geminiConfigDir, { recursive: true });
      await fs.writeFile(
        path.join(geminiConfigDir, 'mcp_config.json'),
        JSON.stringify({ mcpServers: { myServer: { command: 'node' } } }),
        'utf8',
      );

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '2.0.0', // Unsupported version
      };

      const inventory = await readAgyInventory(deps);
      expect(inventory.cliVersion).toBe('2.0.0');
      expect(inventory.versionSupported).toBe(false);
      expect(inventory.writable).toBe(false);

      const item = inventory.items.find((i) => i.name === 'myServer');
      expect(item?.toggleable).toBe(false);
      expect(item?.readOnlyReason).toBe('CLI version not supported (read-only)');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves same-named skills in user and project roots without dropping', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-dup-skills-home-'));
    const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-dup-skills-proj-'));

    try {
      const userSkillDir = path.join(tempDir, '.gemini', 'config', 'skills', 'shared-skill');
      const projSkillDir = path.join(projDir, '.agents', 'skills', 'shared-skill');

      await fs.mkdir(userSkillDir, { recursive: true });
      await fs.mkdir(projSkillDir, { recursive: true });

      await fs.writeFile(
        path.join(userSkillDir, 'SKILL.md'),
        '---\nname: shared-skill\ndescription: User shared skill\n---\nBody',
        'utf8',
      );
      await fs.writeFile(
        path.join(projSkillDir, 'SKILL.md'),
        '---\nname: shared-skill\ndescription: Project shared skill\n---\nBody',
        'utf8',
      );

      const deps: InventoryDeps = {
        homeDir: tempDir,
        projectDir: projDir,
        run: async () => '1.2.14',
      };

      const inventory = await readAgyInventory(deps);
      const sharedSkills = inventory.items.filter(
        (i) => i.name === 'shared-skill' && i.kind === 'skill',
      );

      expect(sharedSkills).toHaveLength(2);
      expect(sharedSkills[0].source).toBe('user');
      expect(sharedSkills[0].id).toBe('agy:skill::shared-skill');

      expect(sharedSkills[1].source).toBe('project');
      expect(sharedSkills[1].id).toBe('agy:skill::shared-skill@project');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(projDir, { recursive: true, force: true });
    }
  });
});
