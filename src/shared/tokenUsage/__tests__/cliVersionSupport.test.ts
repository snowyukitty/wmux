import { describe, it, expect } from 'vitest';
import { cliVersionSupport } from '../capabilities';

describe('cliVersionSupport', () => {
  it.each([
    ['agy', '1.2.14', 'tested'],
    ['agy', '1.2.15', 'tested'],
    ['agy', '1.3.0', 'newer'],
    ['agy', '1.2.13', 'unsupported'],
    ['agy', '2.0.0', 'unsupported'],
    ['codex', '0.156.1', 'tested'],
    ['codex', '0.159.2', 'tested'],
    ['codex', '0.170.0', 'newer'],
    ['codex', '0.155.9', 'unsupported'],
    ['codex', '1.0.0', 'unsupported'],
    ['codex', null, 'unsupported'],
  ] as const)('%s %s → %s', (provider, version, expected) => {
    expect(cliVersionSupport(provider, version)).toBe(expected);
  });
});
