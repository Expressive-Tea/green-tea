# Observability — Design

**Issue:** [#10](https://github.com/Expressive-Tea/green-tea/issues/10) · **Status:** design, not yet implemented · **Constraint:** no new runtime dependency

---

## The diagnosis is not the one in the issue

#10 says green-tea "ships no logging, metrics or tracing contract today", and asks for an injectable logger, structured output, tracing hooks and metrics as one design. The framing is right; the starting point is wrong, and it changes what the work is.

**The mechanism already exists.** `Bus` (`src/bus.ts`) is an in-process event emitter with 19 emission points already wired through boot, the pipeline, streams, WebSockets, mesh and plugins. Plugins already receive `bus.on` — and only `on`, so isolation is structural (`src/plugin.ts:27`).

What is actually missing is narrower and more serious than "there is no logger":

| # | Finding | Where |
|---|---|---|
| 1 | **No event carries request identity.** Under any concurrency, interleaved `request:step:enter` events cannot be attributed to a request. | `src/pipeline.ts:53,56` |
| 2 | **`durationMs` is declared and never set by anything.** There is no timing in the system at all. | `src/bus.ts:22`, zero writers |
| 3 | **No request-level events exist.** No `started`/`completed`/`failed`, so there is no span for step events to hang from. | — |
| 4 | **A failing step is reported as `name: 'pipeline'`**, losing which step broke. | `src/pipeline.ts:98` |
| 5 | **8 `console.warn` calls in core**, unredirectable. | `src/app/index.ts` ×6, `src/deno.ts`, `src/bun.ts` |

So the real statement of the problem is:

> The event stream exists but is **not correlatable and not measured**, which makes it unusable for production observability regardless of what consumes it.

That is *why* #10 is one design and not six — a sharper reason than the issue had. A logger, a metrics exporter and an OpenTelemetry bridge are not three features; they are three **consumers of one corrected event stream**. Fix correlation and timing once, and all three become adapters outside core. Ship them separately and each grows its own private notion of "which request was that", which is the three-mechanisms failure #10 warned about.

**Consequence for sequencing:** most of this work is in `src/bus.ts` and `src/pipeline.ts`, not in new files.

---

## Decisions

### D1 — The logger is a distinct registration, not an ordinary provider

`createApp({ logger })`, not `@Provider({ provides: 'logger' })`.

The deciding constraint is ordering. `boot:provider:start`/`fail` fire *while* the graph is booting (`src/app/index.ts:639-647`), and the optional-provider failure warning at `src/app/index.ts` logs during that same phase. A provider cannot log its own boot failure, and a logger that only exists after the graph resolves cannot report the graph failing to resolve. Shutdown has the same shape: `closeApp` warns after the graph is gone.

The logger is therefore framework infrastructure with a lifetime wider than the graph.

It is *additionally* exposed as an injectable key so steps and handlers reach it with `@needs('logger')` like anything else. One object, two access paths, no second implementation.

**Default:** structured JSON. Human-readable when the process is interactive, decided once at boot rather than per call. **Never a dependency** — the default writes to `console` behind the same interface everyone else implements, which is what lets the 8 direct `console.warn` calls become logger calls without core gaining a logging library.

### D2 — One emitter. Extend `Bus`; do not add a parallel hook system

Per-category hooks would be a second mechanism competing with an emitter that already has 19 call sites and a plugin contract built on it. `LifecycleEvent` grows; nothing new is introduced.

This also keeps the existing guarantee intact: `emit` swallows listener failures (`src/bus.ts:41`) precisely so observers can never break the pipeline. Observability must not acquire the power to take down a request.

**This is exactly why shutdown teardown does not belong here** — see Task 2.5 in the trust-release plan. A teardown must be *awaited*; an observer must not be. Same word, opposite guarantees, so they get different surfaces.

### D3 — A step failure emits both `request:step:error` and `request:failed`

They answer different questions — *which step broke* and *did this request fail* — and a tracing exporter needs both: one marks the span, the other marks the trace. Emitting only the outer event is what produces a trace that says a request failed with no indication where.

`request:step:error` must also carry the real step name. Emitting `name: 'pipeline'` (`src/pipeline.ts:98`) is a bug, not a design choice, and it is fixed as part of this.

### D4 — Streams and WebSockets emit lifecycle events only, never per-message

`stream:open`/`close`/`error` already exist and are the right granularity. A per-message event on a high-rate SSE or WebSocket stream is a firehose that costs more than it reports, and the cost lands on the workload least able to absorb it.

Anyone who needs per-message visibility instruments their own handler, where they know the message semantics. Same reasoning that keeps WebSocket upgrades outside the concurrency gate in #21.

### D5 — Request identity is generated with `crypto.randomUUID()`, and inherited when offered

No new dependency is available, so no UUID library. `globalThis.crypto.randomUUID` is present on Node, Deno and Bun (verified locally) and is Web Crypto on workerd.

**To validate during implementation:** Node 18 is the floor in `package.json` and CI's `build` job pins `node-version: '18'`, so a gap there fails CI rather than reaching a user. `test:edge` covers workerd the same way.

An incoming `x-request-id` is adopted rather than replaced — a green-tea service behind a gateway must not start a second identity for the same request. A `traceparent` header, if present, is carried as `traceId` untouched; core parses nothing and implements no propagation spec. That belongs in the OpenTelemetry adapter, which owns W3C Trace Context.

---

## The contract

### Events

Existing, unchanged in name: `boot:provider:start|ok|fail`, `request:step:enter|leave|error`, `stream:open|close|error`, `mesh:connect|disconnect|rpc:error`, `plugin:mounted`.

Added:

```
request:start      request:end      request:failed
route:matched      route:unmatched
graph:resolved     graph:failed
```

`route:unmatched` rather than the report's `route.not_found`: a 405 is also an unmatched route and is not a 404, and naming the event after one outcome would misreport the other.

### Payload

`EventPayload` gains the correlation and measurement fields it lacks. Every field stays optional — mesh and boot events have no request to name, and forcing a shape on them would mean inventing values.

```ts
interface EventPayload {
  name: string;
  scope?: string;
  error?: unknown;
  durationMs?: number;   // declared today, written by nothing — this design makes it real
  requestId?: string;    // the correlation fix
  traceId?: string;      // inherited from traceparent when present; never synthesized
  route?: string;        // the matched pattern, not the raw URL — bounded cardinality for metrics
  method?: string;
  transport?: Transport;
  status?: number;
  runtime?: 'node' | 'deno' | 'bun' | 'edge';
}
```

`route` is the **pattern** (`/users/:id`), never the concrete path. A metrics consumer that labels a counter with the raw URL produces unbounded cardinality and takes down the metrics backend rather than the app — the framework should not hand a user that shape by default.

### Metrics

No metrics registry in core, and no new event type for them. Per-step timings come from `durationMs` on the events already defined; a metrics adapter subscribes and aggregates. The graph already knows every node, which is what makes this close to free — but the timing instrumentation is measured before it is declared free, per Trust Release §6, and stays opt-in if the measurement says otherwise.

---

## Out of scope, deliberately

- **OpenTelemetry itself.** A separate `@green-tea/opentelemetry` package. Core exposes the stream; it never imports an exporter, and never depends on one.
- **Log shipping, sampling, redaction.** Consumer concerns. Core hands over structured records.
- **Trace context propagation.** Carried, not parsed. The adapter owns W3C Trace Context.
- **Shutdown teardown for plugins/providers.** Task 2.5, a different guarantee — see D2.

---

## Open questions for review

1. **Is `request:start`/`end` the right boundary on a streaming route?** A stream returns from `handle()` long before it finishes. Ending the request span at return means an SSE connection reports as a 2 ms request; ending it at stream close means an hour-long request. The same split #21 hit with its concurrency gate, and it should be answered the same way in both places rather than differently.
2. **Does `runSteps` measure per step, or only the pipeline total?** Per step is what makes the graph's timing story real, and it is `performance.now()` twice per step on the hot path. Benchmark before committing, `npm run bench` is already there.
3. **Does the logger receive events, or do events feed the logger?** If the default logger is just a Bus subscriber, request logging is composable exactly as #10 asks ("a composable step, not a global middleware") and there is only one path. If it is separate, there are two. Leaning subscriber; wants a second opinion.

---

## Verification this design must survive

`npm run lint && npm run format:check && npm run typecheck && npm test`, plus `test:deno`, `test:bun` and `test:edge` — all four now gate a merge. Per-request instrumentation is on the hot path, so `npm run bench` before and after, with the numbers in the implementation plan.
