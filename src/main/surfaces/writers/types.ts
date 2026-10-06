import type {
  ProviderInventory,
  SurfaceApplyResult,
  SurfaceItem,
  SurfacePreview,
  SurfaceProviderId,
} from '../../../shared/tokenUsage/surfaceTypes';
import type { CliRunner } from '../inventory/types';

export interface WriterDeps {
  homeDir: string;
  projectDir?: string;
  run: CliRunner;
  now: () => number;
  /** Absolute path of surfaces.json (intent + removed hooks); injected so tests never touch the real one. */
  surfacesStorePath: string;
}

/** A validated change: the item exists in the fresh inventory, is toggleable and the CLI version is supported. */
export interface ResolvedChange {
  item: SurfaceItem;
  enabled: boolean;
}

export interface WriterContext {
  deps: WriterDeps;
  inventory: ProviderInventory;
  changes: ResolvedChange[];
}

export interface SurfaceWriter {
  provider: SurfaceProviderId;
  preview(ctx: WriterContext): Promise<Omit<SurfacePreview, 'rejected'>>;
  apply(ctx: WriterContext): Promise<SurfaceApplyResult>;
}
