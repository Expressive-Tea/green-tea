/**
 * Per-server/adapter request budget.
 *
 * `acquire()` reserves one in-flight request slot. `release()` returns that slot when routing and
 * handler execution finishes; a returned stream does not hold the slot for the stream's lifetime.
 */
export interface RequestGate {
  /**
   * Whether a budget is actually configured.
   *
   * Exposed rather than left for each adapter to re-derive from `opts`, because the gate is what
   * knows: `acquire()` returns `true` unconditionally when there is no limit, so a caller reading
   * only its result cannot tell "admitted" from "not counting", and pays for the bookkeeping either
   * way. `maxConcurrentRequests` is opt-in, so for most applications this is `false` and every
   * per-request cost behind it should be skipped entirely.
   */
  limited: boolean;
  acquire(): boolean;
  release(): void;
}

/** Creates an unlimited gate when `limit` is undefined or non-positive. */
export function createRequestGate(limit: number | undefined): RequestGate {
  let active = 0;
  const limited = limit !== undefined && limit > 0;

  return {
    limited,

    acquire(): boolean {
      if (limit === undefined || limit <= 0) return true;
      if (active >= limit) return false;

      active++;
      return true;
    },

    release(): void {
      if (limit === undefined || limit <= 0) return;
      if (active > 0) active--;
    },
  };
}
