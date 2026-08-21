/**
 * Per-server/adapter request budget.
 *
 * `acquire()` reserves one in-flight request slot. `release()` returns that slot when routing and
 * handler execution finishes; a returned stream does not hold the slot for the stream's lifetime.
 */
export interface RequestGate {
  acquire(): boolean;
  release(): void;
}

/** Creates an unlimited gate when `limit` is undefined or non-positive. */
export function createRequestGate(limit: number | undefined): RequestGate {
  let active = 0;

  return {
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
