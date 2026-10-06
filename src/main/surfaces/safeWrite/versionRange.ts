export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
  build?: string;
}

export function parseSemver(version: string | null | undefined): ParsedSemver | null {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
    build: match[5],
  };
}

export function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && !b.prerelease) return 0;

  const aParts = a.prerelease!.split('.');
  const bParts = b.prerelease!.split('.');
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];

    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;

    const aNum = /^\d+$/.test(aPart) ? Number(aPart) : null;
    const bNum = /^\d+$/.test(bPart) ? Number(bPart) : null;

    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum - bNum;
    } else if (aNum !== null) {
      return -1;
    } else if (bNum !== null) {
      return 1;
    } else {
      const cmp = aPart.localeCompare(bPart);
      if (cmp !== 0) return cmp;
    }
  }

  return 0;
}

export interface VersionRange {
  min?: string;
  max?: string;
}

export function isVersionInRange(
  version: string | null | undefined,
  range: VersionRange,
): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;

  if (range.min !== undefined) {
    const parsedMin = parseSemver(range.min);
    if (!parsedMin) return false;
    if (compareSemver(parsed, parsedMin) < 0) return false;
  }

  if (range.max !== undefined) {
    const parsedMax = parseSemver(range.max);
    if (!parsedMax) return false;
    if (compareSemver(parsed, parsedMax) > 0) return false;
  }

  return true;
}
