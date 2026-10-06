import type { SurfaceApplyResult, SurfacePreview, SurfaceProviderId } from './surfaceTypes';

export interface SurfaceProfileProviderState {
  knownItemIds: string[];
  disabledItemIds: string[];
}

export interface SurfaceProfile {
  id: string;
  name: string;
  createdAt: number;
  providers: Partial<Record<SurfaceProviderId, SurfaceProfileProviderState>>;
}

export interface ProfileMissingReport {
  count: number;
  firstFewIds: string[];
  ids?: string[];
}

export interface ProfilePreviewProviderResult extends SurfacePreview {
  missingCount?: number;
  newItemsCount?: number;
  skippedWmuxRequired?: number;
}

export interface ProfileApplyProviderResult extends SurfaceApplyResult {
  missingCount?: number;
  newItemsCount?: number;
  skippedWmuxRequired?: number;
  nothingToChange?: boolean;
}

export interface ProfilePreviewResult {
  ok: boolean;
  providers: Partial<Record<SurfaceProviderId, ProfilePreviewProviderResult>>;
  missing: ProfileMissingReport;
  newItems: number;
  skippedWmuxRequired?: number;
}

export interface ProfileApplyAggregateResult {
  ok: boolean;
  providers: Partial<Record<SurfaceProviderId, ProfileApplyProviderResult>>;
  missing: ProfileMissingReport;
  newItems: number;
  skippedWmuxRequired?: number;
  nothingToChange?: boolean;
}

export interface SaveProfileRequest {
  name: string;
  providers?: SurfaceProviderId[];
}

export interface SaveProfileResult {
  ok: boolean;
  profile?: SurfaceProfile;
  skippedProviders?: { provider: SurfaceProviderId; reason: string }[];
  error?: string;
}

export interface ApplyProfileOptions {}
