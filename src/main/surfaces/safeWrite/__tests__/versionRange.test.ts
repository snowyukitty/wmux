import { describe, it, expect } from 'vitest';
import { isVersionInRange, parseSemver, compareSemver } from '../versionRange';

describe('versionRange', () => {
  it('parses valid semver strings with optional v prefix and prereleases', () => {
    expect(parseSemver('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: undefined,
      build: undefined,
    });

    expect(parseSemver('v2.14.0-alpha.1+build123')).toEqual({
      major: 2,
      minor: 14,
      patch: 0,
      prerelease: 'alpha.1',
      build: 'build123',
    });

    expect(parseSemver('invalid')).toBeNull();
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
  });

  it('compares semvers correctly according to SemVer 2.0 rules', () => {
    const v1 = parseSemver('1.2.3')!;
    const v2 = parseSemver('1.2.4')!;
    const v3 = parseSemver('1.3.0')!;
    const v4 = parseSemver('2.0.0')!;
    const vPre = parseSemver('1.2.3-alpha.1')!;

    expect(compareSemver(v1, v2)).toBeLessThan(0);
    expect(compareSemver(v2, v1)).toBeGreaterThan(0);
    expect(compareSemver(v1, v1)).toBe(0);

    expect(compareSemver(v2, v3)).toBeLessThan(0);
    expect(compareSemver(v3, v4)).toBeLessThan(0);

    // Normal version has higher precedence than prerelease
    expect(compareSemver(vPre, v1)).toBeLessThan(0);
    expect(compareSemver(v1, vPre)).toBeGreaterThan(0);
  });

  it('checks version within range [min, max] inclusive', () => {
    expect(isVersionInRange('1.2.14', { min: '1.2.0', max: '1.3.0' })).toBe(true);
    expect(isVersionInRange('v1.2.14', { min: '1.2.0', max: '1.3.0' })).toBe(true);

    // Exact min boundary
    expect(isVersionInRange('1.2.0', { min: '1.2.0' })).toBe(true);
    // Exact max boundary
    expect(isVersionInRange('1.3.0', { max: '1.3.0' })).toBe(true);

    // Below min
    expect(isVersionInRange('1.1.9', { min: '1.2.0' })).toBe(false);
    // Above max
    expect(isVersionInRange('1.3.1', { max: '1.3.0' })).toBe(false);

    // Only min
    expect(isVersionInRange('0.141.0', { min: '0.141.0' })).toBe(true);
    expect(isVersionInRange('0.140.9', { min: '0.141.0' })).toBe(false);

    // Prerelease below floor
    expect(isVersionInRange('0.141.0-alpha', { min: '0.141.0' })).toBe(false);

    // Unparseable / null
    expect(isVersionInRange('not-semver', { min: '1.0.0' })).toBe(false);
    expect(isVersionInRange(null, { min: '1.0.0' })).toBe(false);
    expect(isVersionInRange(undefined, { min: '1.0.0' })).toBe(false);
  });
});
