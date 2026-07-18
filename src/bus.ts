/** Names of every lifecycle event the framework emits over the {@link Bus}. */
export type LifecycleEvent =
  | 'boot:provider:start'
  | 'boot:provider:ok'
  | 'boot:provider:fail'
  | 'request:step:enter'
  | 'request:step:leave'
  | 'request:step:error'
  | 'stream:open'
  | 'stream:close'
  | 'stream:error'
  | 'mesh:connect'
  | 'mesh:disconnect'
  | 'mesh:rpc:error'
  | 'plugin:mounted';

/** Data carried by a lifecycle event: the subject's name plus optional scope, error and timing. */
export interface EventPayload {
  name: string;
  scope?: string;
  error?: unknown;
  durationMs?: number;
}

/** In-process pub/sub for framework lifecycle events; observer failures are swallowed so they never break the pipeline. */
export class Bus {
  private readonly listeners = new Map<LifecycleEvent, Set<(p: EventPayload) => void>>();

  /** Subscribe `listener` to `event`; returns an unsubscribe function. */
  on(event: LifecycleEvent, listener: (p: EventPayload) => void): () => void {
    const listenerSet = this.listeners.get(event) ?? new Set();
    listenerSet.add(listener);
    this.listeners.set(event, listenerSet);
    return () => listenerSet.delete(listener);
  }

  /** Dispatch `payload` to every listener of `event`; a throwing listener is isolated and does not affect the others. */
  emit(event: LifecycleEvent, payload: EventPayload): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch {
        /* observers must never break the pipeline */
      }
    }
  }
}
