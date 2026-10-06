import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcRouter } from '../../RpcRouter';

const mirrorState = vi.hoisted(() => ({
  entries: null as Array<{ id: string }> | null,
  ageMs: 0,
  restored: true,
}));
const reconcileMock = vi.hoisted(() => vi.fn());

vi.mock('../../../workspace/WorkspaceMirror', () => ({
  getWorkspaceMirror: () => ({
    getEntries: () => mirrorState.entries,
    peek: () => (mirrorState.entries ? { ageMs: mirrorState.ageMs } : null),
    isSessionRestored: () => mirrorState.restored,
  }),
}));
vi.mock('../../../deck/deckOrphanReconcile', () => ({ reconcileOrphanDeckState: reconcileMock }));

import { registerDeckRpc } from '../deck.rpc';

function call(): ReturnType<RpcRouter['dispatch']> {
  const router = new RpcRouter();
  registerDeckRpc(router, () => null, { deckDir: () => '/deck-dir' });
  return router.dispatch({ id: '1', method: 'deck.state.prune', params: {} });
}

describe('deck.state.prune', () => {
  beforeEach(() => {
    reconcileMock.mockReset();
    mirrorState.entries = [{ id: 'ws-live' }, { id: 'ws-other' }];
    mirrorState.ageMs = 0;
    mirrorState.restored = true;
  });

  it('prunes in the app against the live workspace list and reports what changed', async () => {
    reconcileMock.mockResolvedValue({ orphans: [], archived: ['ws-gone'], tornDown: ['ws-gone'], skippedIds: ['ws-parked'] });
    const res = await call();
    expect(res.ok).toBe(true);
    expect((res as { result: unknown }).result).toEqual({ archived: ['ws-gone'], tornDown: ['ws-gone'], skipped: ['ws-parked'] });
    expect(reconcileMock).toHaveBeenCalledWith(['ws-live', 'ws-other'], expect.objectContaining({ dir: '/deck-dir', dryRun: false }));
  });

  it('refuses while the workspace list is not loaded', async () => {
    mirrorState.entries = null;
    const res = await call();
    expect(res.ok).toBe(false);
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it('refuses when the saved session was not restored', async () => {
    mirrorState.restored = false;
    const res = await call();
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain('not restored');
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
