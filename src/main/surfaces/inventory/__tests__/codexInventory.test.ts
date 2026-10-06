import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readCodexInventory } from '../codexInventory';
import type { InventoryDeps } from '../types';

describe('readCodexInventory', () => {
  it('reads codex inventory with all required fixture scenarios', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-inventory-test-'));

    try {
      const codexDir = path.join(tempDir, '.codex');
      const agentsSkillsDir = path.join(tempDir, '.agents', 'skills');
      const systemSkillsDir = path.join(codexDir, 'skills', '.system');

      await fs.mkdir(codexDir, { recursive: true });
      await fs.mkdir(agentsSkillsDir, { recursive: true });
      await fs.mkdir(systemSkillsDir, { recursive: true });

      // Skills on disk
      const disabledSkillDir = path.join(agentsSkillsDir, 'skill-disabled');
      await fs.mkdir(disabledSkillDir, { recursive: true });
      const disabledSkillPath = path.join(disabledSkillDir, 'SKILL.md');
      await fs.writeFile(
        disabledSkillPath,
        '---\nname: skill-disabled\ndescription: Disabled skill\n---\nBody',
        'utf8',
      );

      const activeSkillDir = path.join(agentsSkillsDir, 'skill-active');
      await fs.mkdir(activeSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(activeSkillDir, 'SKILL.md'),
        '---\nname: skill-active\ndescription: Active skill\n---\nBody',
        'utf8',
      );

      // System skill
      const sysSkillDir = path.join(systemSkillsDir, 'sys-skill');
      await fs.mkdir(sysSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(sysSkillDir, 'SKILL.md'),
        '---\nname: sys-skill\ndescription: System skill\n---\nBody',
        'utf8',
      );

      // config.toml with:
      // - MCP servers (wmux, server-disabled, server-with-tools)
      // - plugin disabled
      // - skill disabled via [[skills.config]]
      // - hooks.state with enabled = false
      // - features table
      // - wmux notify
      const tomlContent = `
notify = ["node", "C:/path/to/wmux-codex-notify.mjs"]

[mcp_servers.wmux]
command = "node"
args = ["wmux-mcp.js"]

[mcp_servers.server_disabled]
command = "node"
enabled = false

[mcp_servers.server_tools]
command = "node"
enabled = true
disabled_tools = ["toolX"]
enabled_tools = ["toolY"]

[plugins."test@marketplace"]
enabled = false

[[skills.config]]
path = ${JSON.stringify(disabledSkillPath)}
enabled = false

[features]
shell_tool = true
web_search = "disabled"

[hooks.state.${JSON.stringify(`${path.join(codexDir, 'hooks.json')}:pre_tool_use:0:0`)}]
enabled = false

# Same event and handler index, but another file: must not switch off this file's hook.
[hooks.state.${JSON.stringify(`${path.join(tempDir, 'elsewhere', 'hooks.json')}:stop:0:1`)}]
enabled = false
`;
      await fs.writeFile(path.join(codexDir, 'config.toml'), tomlContent, 'utf8');

      // hooks.json with hooks
      const hooksJson = {
        'hook-from-json': {
          event: 'PreToolUse',
          command: 'node hook.js',
          enabled: true,
        },
        'hook-stop': {
          event: 'Stop',
          command: 'node stop.js',
          enabled: true,
        },
      };
      await fs.writeFile(
        path.join(codexDir, 'hooks.json'),
        JSON.stringify(hooksJson),
        'utf8',
      );

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async (cmd, args) => {
          if (cmd === 'codex' && args[0] === '--version') {
            return 'codex 0.159.2';
          }
          throw new Error(`Unexpected command: ${cmd}`);
        },
      };

      const inventory = await readCodexInventory(deps);

      expect(inventory.provider).toBe('codex');
      expect(inventory.cliVersion).toBe('0.159.2');
      expect(inventory.versionSupported).toBe(true);
      expect(inventory.writable).toBe(true);

      // MCP servers
      const wmuxServer = inventory.items.find((i) => i.name === 'wmux' && i.kind === 'mcp-server');
      expect(wmuxServer).toBeDefined();
      expect(wmuxServer?.source).toBe('wmux');
      expect(wmuxServer?.wmuxRequired).toBe(true);

      const disabledServer = inventory.items.find((i) => i.name === 'server_disabled' && i.kind === 'mcp-server');
      expect(disabledServer?.enabled).toBe(false);

      const toolX = inventory.items.find((i) => i.name === 'toolX' && i.kind === 'mcp-tool');
      expect(toolX?.enabled).toBe(false);
      expect(toolX?.parent).toBe('server_tools');

      const toolY = inventory.items.find((i) => i.name === 'toolY' && i.kind === 'mcp-tool');
      expect(toolY?.enabled).toBe(true);

      // Skills: disabled by SKILL.md path entry
      const disabledSkill = inventory.items.find((i) => i.name === 'skill-disabled' && i.kind === 'skill');
      expect(disabledSkill).toBeDefined();
      expect(disabledSkill?.enabled).toBe(false);

      const activeSkill = inventory.items.find((i) => i.name === 'skill-active' && i.kind === 'skill');
      expect(activeSkill?.enabled).toBe(true);

      const sysSkill = inventory.items.find((i) => i.name === 'sys-skill' && i.kind === 'skill');
      expect(sysSkill?.source).toBe('builtin');
      expect(sysSkill?.toggleable).toBe(false);
      expect(sysSkill?.readOnlyReason).toBe('Built-in skills cannot be disabled');

      // Plugin
      const plugin = inventory.items.find((i) => i.name === 'test@marketplace' && i.kind === 'plugin');
      expect(plugin).toBeDefined();
      expect(plugin?.enabled).toBe(false);

      // Hooks: hook-from-json disabled via [hooks.state.*] enabled = false
      const hookJson = inventory.items.find((i) => i.name === 'hook-from-json' && i.kind === 'hook');
      expect(hookJson).toBeDefined();
      expect(hookJson?.enabled).toBe(false);
      expect(hookJson?.hookCost).toBe('injects-context');

      const hookStop = inventory.items.find((i) => i.name === 'hook-stop' && i.kind === 'hook');
      expect(hookStop?.hookCost).toBe('extra-turn');
      expect(hookStop?.enabled).toBe(true);

      // wmux notify hook
      const notifyHook = inventory.items.find((i) => i.name === 'codex-notify' && i.kind === 'hook');
      expect(notifyHook).toBeDefined();
      expect(notifyHook?.source).toBe('wmux');
      expect(notifyHook?.wmuxRequired).toBe(true);

      // Built-in tools
      const shellTool = inventory.items.find((i) => i.name === 'shell_tool' && i.kind === 'builtin-tool');
      expect(shellTool?.enabled).toBe(true);

      const webSearch = inventory.items.find((i) => i.name === 'web_search' && i.kind === 'builtin-tool');
      expect(webSearch?.enabled).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('handles malformed TOML by adding warning and returning rest', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-malformed-test-'));

    try {
      const codexDir = path.join(tempDir, '.codex');
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(path.join(codexDir, 'config.toml'), 'invalid toml [[[', 'utf8');

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '0.159.2',
      };

      const inventory = await readCodexInventory(deps);
      expect(inventory.warnings.some((w) => w.includes('Failed to parse TOML'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('marks unsupported version as versionSupported:false and writable:false', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-version-test-'));

    try {
      const codexDir = path.join(tempDir, '.codex');
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(
        path.join(codexDir, 'config.toml'),
        '[mcp_servers.srv]\ncommand="node"',
        'utf8',
      );

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '0.150.0', // older than the tested minimum
      };

      const inventory = await readCodexInventory(deps);
      expect(inventory.versionSupported).toBe(false);
      expect(inventory.writable).toBe(false);
      const srv = inventory.items.find((i) => i.name === 'srv');
      expect(srv?.toggleable).toBe(false);
      expect(srv?.readOnlyReason).toBe('CLI version not supported (read-only)');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps a release newer than the last tested one writable, with a warning', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-version-newer-'));
    try {
      await fs.mkdir(path.join(tempDir, '.codex'), { recursive: true });
      await fs.writeFile(path.join(tempDir, '.codex', 'config.toml'), '[mcp_servers.srv]\ncommand="node"', 'utf8');
      const inventory = await readCodexInventory({ homeDir: tempDir, run: async () => '0.160.0' } as InventoryDeps);
      expect(inventory.versionSupported).toBe(true);
      expect(inventory.writable).toBe(true);
      expect(inventory.warnings.some((w) => w.includes('newer than the last version wmux tested'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves same-named skills in user and project roots without dropping', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dup-skills-home-'));
    const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-dup-skills-proj-'));

    try {
      const userSkillDir = path.join(tempDir, '.agents', 'skills', 'shared-skill');
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
        run: async () => '0.159.2',
      };

      const inventory = await readCodexInventory(deps);
      const sharedSkills = inventory.items.filter(
        (i) => i.name === 'shared-skill' && i.kind === 'skill',
      );

      expect(sharedSkills).toHaveLength(2);
      expect(sharedSkills[0].source).toBe('user');
      expect(sharedSkills[0].id).toBe('codex:skill::shared-skill');

      expect(sharedSkills[1].source).toBe('project');
      expect(sharedSkills[1].id).toBe('codex:skill::shared-skill@project');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.rm(projDir, { recursive: true, force: true });
    }
  });

  it('resolves relative path against config.toml directory and matches Windows-style absolute path with different slashes and drive-letter case', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-paths-test-'));

    try {
      const codexDir = path.join(tempDir, '.codex');
      const agentsSkillsDir = path.join(tempDir, '.agents', 'skills');

      await fs.mkdir(codexDir, { recursive: true });
      await fs.mkdir(agentsSkillsDir, { recursive: true });

      // 1. Skill to be disabled via relative path "../.agents/skills/skill-rel"
      const relSkillDir = path.join(agentsSkillsDir, 'skill-rel');
      await fs.mkdir(relSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(relSkillDir, 'SKILL.md'),
        '---\nname: skill-rel\ndescription: Disabled via relative path\n---\nBody',
        'utf8',
      );

      // 2. Skill to be disabled via Windows-style path with inverted slashes and toggled drive-letter case
      const absSkillDir = path.join(agentsSkillsDir, 'skill-abs');
      await fs.mkdir(absSkillDir, { recursive: true });
      await fs.writeFile(
        path.join(absSkillDir, 'SKILL.md'),
        '---\nname: skill-abs\ndescription: Disabled via inverted Windows path\n---\nBody',
        'utf8',
      );

      // Invert slashes and toggle drive letter case (e.g. C:\ -> c:/ or / -> \)
      let swappedPath = absSkillDir.replace(/\\/g, '/');
      if (/^[a-zA-Z]:/.test(swappedPath)) {
        const first = swappedPath[0];
        const toggled = first === first.toUpperCase() ? first.toLowerCase() : first.toUpperCase();
        swappedPath = toggled + swappedPath.slice(1);
      }

      const tomlContent = `
[[skills.config]]
path = "../.agents/skills/skill-rel"
enabled = false

[[skills.config]]
path = ${JSON.stringify(swappedPath)}
enabled = false
`;
      await fs.writeFile(path.join(codexDir, 'config.toml'), tomlContent, 'utf8');

      const deps: InventoryDeps = {
        homeDir: tempDir,
        run: async () => '0.159.2',
      };

      const inventory = await readCodexInventory(deps);

      const relSkill = inventory.items.find((i) => i.name === 'skill-rel' && i.kind === 'skill');
      expect(relSkill).toBeDefined();
      expect(relSkill?.enabled).toBe(false);

      const absSkill = inventory.items.find((i) => i.name === 'skill-abs' && i.kind === 'skill');
      expect(absSkill).toBeDefined();
      expect(absSkill?.enabled).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('readCodexInventory context settings', () => {
  it('lists them read-only, since the Codex writer has no edit for them', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ctx-'));
    try {
      await fs.mkdir(path.join(home, '.codex'), { recursive: true });
      await fs.writeFile(path.join(home, '.codex', 'config.toml'), 'model_verbosity = "low"\n', 'utf8');
      const inventory = await readCodexInventory({ homeDir: home, run: async () => 'codex 0.159.2' });
      const item = inventory.items.find((i) => i.kind === 'context-setting' && i.name === 'model_verbosity');
      expect(item?.toggleable).toBe(false);
      expect(item?.enabled).toBeNull();
      expect(item?.readOnlyReason).toBeTruthy();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
