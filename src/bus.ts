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
  | 'plugin:mounted'
  | 'request:failed';

/**
 * Data carried by a lifecycle event: the subject's name plus optional scope, error, timing and
 * the fields that say which request it belongs to.
 *
 * Everything past `name` is optional and stays that way. Boot and mesh events have no request to
 * name, and requiring a shape they cannot fill would only mean inventing values for it.
 */
export interface EventPayload {
  name: string;
  scope?: string;
  error?: unknown;
  durationMs?: number;
  /** Correlates every event of one request. Adopted from `x-request-id` when a gateway sent one. */
  requestId?: string;
  /** A `traceparent` header carried verbatim. Core parses nothing — that is the exporter's job. */
  traceId?: string;
  /** The matched *pattern* (`/users/:id`), never the concrete path — see {@link Correlation}. */
  route?: string;
  method?: string;
  transport?: string;
  status?: number;
}

/**
 * The subset of {@link EventPayload} that identifies a request, spread into each of its events.
 *
 * `route` carries the matched pattern rather than the URL that arrived, and that is load-bearing
 * rather than cosmetic: a metrics consumer that labels a counter with a concrete path gets one
 * label per distinct URL, and unbounded label cardinality takes down the metrics backend rather
 * than the application. Handing anyone that shape by default would be the framework's fault.
 */
export type Correlation = Pick<EventPayload, 'requestId' | 'traceId' | 'route' | 'method' | 'transport'>;

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
