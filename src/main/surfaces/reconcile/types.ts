import type { SurfaceKind } from '../../../shared/tokenUsage/surfaceTypes';

export interface SurfaceDriftedItem {
  itemId: string;
  name: string;
  kind: SurfaceKind;
  wanted: boolean;
  actual: boolean;
}

export interface SurfaceReconcileResult {
  newItems: number;
  removedItems: number;
  driftedItems: SurfaceDriftedItem[];
  driftedCount: number;
  truncated: boolean;
}
