import { describe, it, expect } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { editTomlKeys, TomlEditError } from '../tomlEdit';

const REALISTIC_CODEX_CONFIG = `web_search = "live"
default_tools_approval_mode = "ask"

# Project trust entry with Windows path
[projects.'c:\\users\\x']
trust_level = "trusted"

# Plugin entry with special characters in name
[plugins."documents@openai-primary-runtime"]
enabled = false # disabled by operator

# MCP server config
[mcp_servers.wmux]
command = "node"
args = ["dist/index.js"]

# User skills config
[[skills.config]]
path = 'C:\\Users\\x\\.agents\\skills\\review\\SKILL.md'
enabled = true # primary skill

# Hook state with trusted_hash
[hooks.state.'C:\\Users\\x\\.codex\\hooks.json:pre_tool_use:0:0']
enabled = true
trusted_hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
`;

describe('editTomlKeys', () => {
  it('empty edits returns input byte-for-byte', () => {
    expect(editTomlKeys(REALISTIC_CODEX_CONFIG, [])).toBe(REALISTIC_CODEX_CONFIG);
  });

  it('toggles an existing key while keeping inline comment intact', () => {
    const edited = editTomlKeys(REALISTIC_CODEX_CONFIG, [
      {
        table: ['plugins', 'documents@openai-primary-runtime'],
        key: 'enabled',
        op: 'set',
        value: true,
      },
    ]);

    expect(edited).toContain('enabled = true # disabled by operator');
    expect(edited).toContain('# Plugin entry with special characters in name');
    expect(parseToml(edited)).toMatchObject({
      plugins: {
        'documents@openai-primary-runtime': {
          enabled: true,
        },
      },
    });
  });

  it('adds a key to an existing table', () => {
    const edited = editTomlKeys(REALISTIC_CODEX_CONFIG, [
      {
        table: ['mcp_servers', 'wmux'],
        key: 'timeout',
        op: 'set',
        value: 5000,
      },
    ]);

    expect(edited).toContain('timeout = 5000');
    expect(parseToml(edited)).toMatchObject({
      mcp_servers: {
        wmux: {
          command: 'node',
          args: ['dist/index.js'],
          timeout: 5000,
        },
      },
    });
  });

  it('adds a missing table at the end of the file with a leading blank line', () => {
    const edited = editTomlKeys(REALISTIC_CODEX_CONFIG, [
      {
        table: ['plugins', 'brand-new-plugin'],
        key: 'enabled',
        op: 'set',
        value: false,
      },
    ]);

    expect(edited).toMatch(/\n\n\[plugins\.brand-new-plugin\]\nenabled = false/);
    expect(parseToml(edited)).toMatchObject({
      plugins: {
        'brand-new-plugin': {
          enabled: false,
        },
      },
    });
  });

  it('deletes an existing key', () => {
    const edited = editTomlKeys(REALISTIC_CODEX_CONFIG, [
      {
        key: 'default_tools_approval_mode',
        op: 'delete',
      },
    ]);

    expect(edited).not.toContain('default_tools_approval_mode');
    expect(edited).toContain('web_search = "live"');
    const parsed = parseToml(edited) as Record<string, unknown>;
    expect(parsed.default_tools_approval_mode).toBeUndefined();
  });

  it('updates an existing [[skills.config]] entry by path match', () => {
    const edited = editTomlKeys(REALISTIC_CODEX_CONFIG, [
      {
        arrayTable: ['skills', 'config'],
        match: { path: 'C:\\Users\\x\\.agents\\skills\\review\\SKILL.md' },
        key: 'enabled',
        op: 'set',
        value: false,
      },
    ]);

    expect(edited).toContain("path = 'C:\\Users\\x\\.agents\\skills\\review\\SKILL.md'");
    expect(edited).toContain('enabled = false # primary skill');
    expect(parseToml(edited)).toMatchObject({
      skills: {
        config: [
          {
            path: 'C:\\Users\\x\\.agents\\skills\\review\\SKILL.md',
            enabled: false,
          },
        ],
      },
    });
  });

  it('creates a new [[skills.config]] entry when no match exists', () => {
    const edited = editTomlKeys(REALISTIC_CODEX_CONFIG, [
      {
        arrayTable: ['skills', 'config'],
        match: { path: 'C:\\Users\\x\\.agents\\skills\\tester\\SKILL.md' },
        key: 'enabled',
        op: 'set',
        value: true,
      },
    ]);

    expect(edited).toContain("path = 'C:\\Users\\x\\.agents\\skills\\tester\\SKILL.md'");
    expect(parseToml(edited)).toMatchObject({
      skills: {
        config: [
          {
            path: 'C:\\Users\\x\\.agents\\skills\\review\\SKILL.md',
            enabled: true,
          },
          {
            path: 'C:\\Users\\x\\.agents\\skills\\tester\\SKILL.md',
            enabled: true,
          },
        ],
      },
    });
  });

  it('preserves CRLF line endings', () => {
    const crlfConfig = REALISTIC_CODEX_CONFIG.replace(/\n/g, '\r\n');
    const edited = editTomlKeys(crlfConfig, [
      {
        key: 'web_search',
        op: 'set',
        value: 'cached',
      },
    ]);

    expect(edited).toContain('\r\n');
    expect(edited).not.toMatch(/[^\r]\n/);
    expect(edited).toContain('web_search = "cached"');
  });

  it('preserves comments and blank lines intact', () => {
    const edited = editTomlKeys(REALISTIC_CODEX_CONFIG, [
      {
        table: ['mcp_servers', 'wmux'],
        key: 'enabled',
        op: 'set',
        value: true,
      },
    ]);

    expect(edited).toContain('# Project trust entry with Windows path');
    expect(edited).toContain('# MCP server config');
    expect(edited).toContain('# User skills config');
    expect(edited).toContain('# Hook state with trusted_hash');
  });

  it('leaves trusted_hash untouched when editing adjacent keys in the same table', () => {
    const edited = editTomlKeys(REALISTIC_CODEX_CONFIG, [
      {
        table: ['hooks', 'state', 'C:\\Users\\x\\.codex\\hooks.json:pre_tool_use:0:0'],
        key: 'enabled',
        op: 'set',
        value: false,
      },
    ]);

    expect(edited).toContain('trusted_hash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"');
    expect(parseToml(edited)).toMatchObject({
      hooks: {
        state: {
          'C:\\Users\\x\\.codex\\hooks.json:pre_tool_use:0:0': {
            enabled: false,
            trusted_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
          },
        },
      },
    });
  });

  it('never allows editing trusted_hash directly and throws TomlEditError', () => {
    expect(() =>
      editTomlKeys(REALISTIC_CODEX_CONFIG, [
        {
          table: ['hooks', 'state', 'C:\\Users\\x\\.codex\\hooks.json:pre_tool_use:0:0'],
          key: 'trusted_hash',
          op: 'set',
          value: 'malicious-hash',
        },
      ]),
    ).toThrow(TomlEditError);

    expect(() =>
      editTomlKeys(REALISTIC_CODEX_CONFIG, [
        {
          table: ['hooks', 'state', 'C:\\Users\\x\\.codex\\hooks.json:pre_tool_use:0:0'],
          key: 'trusted_hash',
          op: 'delete',
        },
      ]),
    ).toThrow(TomlEditError);
  });

  it('catches invalid original TOML and throws TomlEditError', () => {
    const broken = 'invalid = [1, 2';
    expect(() =>
      editTomlKeys(broken, [{ key: 'foo', op: 'set', value: 'bar' }]),
    ).toThrow(TomlEditError);
  });
});

describe('editTomlKeys with multi-line values', () => {
  const text = [
    '[mcp_servers.wmux]',
    'command = "node"',
    'disabled_tools = [',
    '  "a", # first',
    '  "b]",',
    ']',
    'enabled = true',
    '',
  ].join('\n');

  it('replaces the whole multi-line array', () => {
    const out = editTomlKeys(text, [
      { table: ['mcp_servers', 'wmux'], key: 'disabled_tools', op: 'set', value: ['a', 'b]', 'c'] },
    ]);
    expect(out).toBe(
      ['[mcp_servers.wmux]', 'command = "node"', 'disabled_tools = ["a", "b]", "c"]', 'enabled = true', ''].join('\n'),
    );
  });

  it('deletes the whole multi-line array', () => {
    const out = editTomlKeys(text, [{ table: ['mcp_servers', 'wmux'], key: 'disabled_tools', op: 'delete' }]);
    expect(out).toBe(['[mcp_servers.wmux]', 'command = "node"', 'enabled = true', ''].join('\n'));
  });

  it('does the same inside an array of tables', () => {
    const arr = ['[[hooks]]', 'name = "x"', 'events = [', '  "Stop",', ']', ''].join('\n');
    const out = editTomlKeys(arr, [
      { arrayTable: ['hooks'], match: { name: 'x' }, key: 'events', op: 'set', value: ['Stop', 'Start'] },
    ]);
    expect(out).toBe(['[[hooks]]', 'name = "x"', 'events = ["Stop", "Start"]', ''].join('\n'));
  });
});
