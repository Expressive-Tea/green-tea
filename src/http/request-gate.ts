export interface RequestGate {
  acquire(): boolean;
  release(): void;
}

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
