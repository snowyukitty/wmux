// One promise chain per store file. A store's `loadAll()` (sync) → compute →
// `await atomicWriteJSON` has an async boundary, so two unserialized callers can
// read the same snapshot and the later write drops the earlier one's change
// (e.g. a teardown delete resurrecting a setter's just-written entry). Running
// every read-modify-write of one file through its chain makes them atomic per
// process. Same shape as deckDecisionStore's private chain.
export function createSerialChain(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    // Keep the chain alive even if a write rejects (never wedge later callers).
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
