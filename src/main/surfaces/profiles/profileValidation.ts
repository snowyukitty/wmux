import type { SurfaceProviderId } from '../../../shared/tokenUsage/surfaceTypes';

const VALID_PROVIDERS: ReadonlySet<SurfaceProviderId> = new Set(['claude', 'codex', 'agy']);

export function validateProfileName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error('Profile name must be a string.');
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 40) {
    throw new Error('Profile name must be between 1 and 40 characters.');
  }
  return trimmed;
}

export function assertValidProviders(providers: unknown): SurfaceProviderId[] {
  if (!Array.isArray(providers)) {
    throw new Error('Providers must be an array.');
  }
  for (const p of providers) {
    if (typeof p !== 'string' || !VALID_PROVIDERS.has(p as SurfaceProviderId)) {
      throw new Error(`Unknown provider: ${String(p)}.`);
    }
  }
  return providers as SurfaceProviderId[];
}
