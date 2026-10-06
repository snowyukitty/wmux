import { describe, expect, it } from 'vitest';
import { launchRefusesPositionalPrompt, promptFlagForLauncher } from '../orchestratorRole';

describe('agy prompt flag on wmux-assembled worker lines', () => {
  it('asks for -i on an agy launcher that has no prompt-taking flag', () => {
    expect(promptFlagForLauncher('agy')).toBe('-i');
    expect(promptFlagForLauncher('agy --model gemini-3.8-flash-high')).toBe('-i');
    expect(promptFlagForLauncher('C:\\Tools\\agy.exe')).toBe('-i');
    expect(launchRefusesPositionalPrompt('C:\\Tools\\agy.exe "x"')).toBe(true);
  });

  it('adds nothing when a prompt-taking flag is already there, or for other CLIs', () => {
    for (const cmd of ['agy -i', 'agy --prompt-interactive', 'agy -p', 'agy --print', 'agy --print=json']) {
      expect(promptFlagForLauncher(cmd)).toBeUndefined();
    }
    expect(promptFlagForLauncher('claude')).toBeUndefined();
    expect(promptFlagForLauncher('codex --model gpt-6-sol')).toBeUndefined();
    expect(promptFlagForLauncher('')).toBeUndefined();
  });

  it('flags only an agy line that passes a prompt without a prompt-taking flag', () => {
    expect(launchRefusesPositionalPrompt('agy "$(cat \'/m/p.md\')"')).toBe(true);
    expect(launchRefusesPositionalPrompt('agy -i "$(cat \'/m/p.md\')"')).toBe(false);
    expect(launchRefusesPositionalPrompt('agy --model x -i "$(cat \'/m/p.md\')"')).toBe(false);
    // A quoted "-i" is prompt text, not the flag.
    expect(launchRefusesPositionalPrompt('agy "-i"')).toBe(true);
    expect(launchRefusesPositionalPrompt('agy')).toBe(false);
    expect(launchRefusesPositionalPrompt('claude "$(cat \'/m/p.md\')"')).toBe(false);
  });
});
