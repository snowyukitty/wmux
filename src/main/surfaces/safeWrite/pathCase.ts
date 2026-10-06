/**
 * Folds a path's case only where the filesystem ignores it by default (Windows, macOS). On Linux,
 * `/home/u/.Claude` and `/home/u/.claude` are different paths, so folding there would let a
 * case variant pass a containment check.
 */
export function foldPathCase(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}
