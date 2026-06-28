export type LifecycleEvent =
  | 'boot:provider:start' | 'boot:provider:ok' | 'boot:provider:fail'
  | 'request:step:enter' | 'request:step:leave' | 'request:step:error'
  | 'stream:open' | 'stream:close' | 'stream:error'
  | 'mesh:connect' | 'mesh:disconnect' | 'mesh:rpc:error'
  | 'plugin:mounted';

export interface EventPayload {
  name: string;
  scope?: string;
  error?: unknown;
  durationMs?: number;
}

export class Bus {
  private readonly listeners = new Map<LifecycleEvent, Set<(p: EventPayload) => void>>();

  on(event: LifecycleEvent, fn: (p: EventPayload) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
    return () => set.delete(fn);
  }

  emit(event: LifecycleEvent, p: EventPayload): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try { fn(p); } catch { /* observers must never break the pipeline */ }
    }
  }
}
