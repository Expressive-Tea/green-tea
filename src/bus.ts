/**
 * Names of every lifecycle event the framework emits over the {@link Bus}.
 *
 * ### The request pair is a guarantee
 *
 * **Every `request:end` is preceded by a `request:start` carrying the same `requestId`.** A
 * consumer may open per-request state on the first and close it on the second without checking
 * whether the request got as far as a route — a shed `503` emits the pair as surely as a `200`
 * does.
 *
 * This is a promise to emitters as much as to subscribers: a terminal path that emits one must
 * emit the other, in that order. It held by accident until `maxConcurrentRequests` added the first
 * terminal path that does not reach the router, and `test/lifecycle-pairing.test.ts` enumerates
 * every response shape so that the next one cannot break it quietly. The alternative — documenting
 * `request:end` as standalone — was rejected because it makes the obvious consumer wrong: an
 * in-flight gauge counting `start` up and `end` down would drift negative under shedding, which is
 * exactly when an operator is reading it.
 *
 * ### `request:end` is terminal and universal; the others are additional
 *
 * `request:end` fires for every dispatched request — handled, thrown and unmatched alike — and is
 * the only one of these carrying the real status. **Count it, and nothing else.**
 * `request:failed` and `route:unmatched` describe the *same* request and fire in addition to it, so
 * a consumer that counts them as separate outcomes counts one request twice. See `EventPayload`.
 */
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
  // A boot-time connect attempt that failed and will be retried until `bootTimeoutMs` passes.
  // Separate from `mesh:disconnect`, which is a link that was up and went away — this one never
  // came up, and a deploy watching for trouble wants to tell those apart.
  | 'mesh:boot:retry'
  | 'plugin:mounted'
  // Paired: see the guarantee above. `request:start` has no status and no duration — it says a
  // request arrived, not that it routed.
  | 'request:start'
  | 'request:end'
  // "handler code threw", and *additional* to the `request:end` that follows it — a rendered 422 is
  // also a throw, which is a thing a status alone cannot express.
  | 'request:failed'
  | 'route:matched'
  // Covers a 404 *and* a 405 — the report's `route.not_found` names one outcome and would
  // misreport the other, and "no route ran" is the fact a consumer actually wants.
  | 'route:unmatched';

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

  /**
   * Whether anything is listening to `event` — for skipping the *construction* of a payload nobody
   * will read.
   *
   * Not a micro-optimisation looking for a problem. A correlated payload is built by spreading the
   * request's identity into it, and that spread was measured at ~197 ns per request on a two-step
   * pipeline — against a ~4.5 µs in-process request, on a path where the overwhelmingly common
   * case is an application that subscribes to nothing at all. `emit` cannot help: its argument is
   * already built by the time it is called. Only the caller can decline to build it.
   */
  hasListeners(event: LifecycleEvent): boolean {
    const listenerSet = this.listeners.get(event);
    return listenerSet !== undefined && listenerSet.size > 0;
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
