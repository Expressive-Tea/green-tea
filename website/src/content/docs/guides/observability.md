---
title: Observability
description: A correlated lifecycle event stream, an injectable logger, and where exporters go.
---

green-tea does not integrate with an observability vendor. It emits a **correlated event stream** and
lets you read it. A logger, a metrics exporter and a tracing bridge are three consumers of that one
stream — not three features, which is why they are one design.

The rule that shapes all of it: core has one runtime dependency, `reflect-metadata`, and keeps it.
Nothing here imports an exporter.

## Correlation

Every request gets an id. Every event it causes carries that id.

```ts
app.bus.on('request:step:leave', (event) => {
  event.requestId; // "9f0c…" — the same value on every event of this request
  event.route;     // "/users/:id" — the pattern, never the concrete path
  event.durationMs; // how long this step took
});
```

Without that id the stream is unusable under any concurrency: two requests interleave their step
events and nothing tells you which is which.

**An incoming `x-request-id` is adopted, not replaced.** A service behind a gateway must not open a
second identity for a request that already has one.

**A `traceparent` header is carried through untouched** as `traceId`. Core parses nothing and
implements no propagation spec — W3C Trace Context belongs to the exporter that understands it.

### `route` is the pattern, always

`route` is `/users/:id`, never `/users/42`. This is a contract, not an implementation detail: a
metrics consumer that labels a counter with the concrete path gets one label per distinct URL, and
unbounded label cardinality takes down the metrics backend rather than the application.

## The events

| Event | When |
|---|---|
| `request:start` / `request:end` | a request enters and leaves the handler |
| `request:failed` | the request produced an error |
| `route:matched` / `route:unmatched` | a route matched, or none did (covers **404 and 405**) |
| `request:step:enter` / `:leave` / `:error` | one step of the pipeline |
| `boot:provider:start` / `:ok` / `:fail` | a provider booting |
| `stream:open` / `:close` / `:error` | an SSE, ndjson or WebSocket connection |
| `mesh:connect` / `:disconnect` / `:rpc:error` | mesh links |
| `plugin:mounted` | a plugin registered |

### Where a streaming request ends

`request:end` fires **when the handler returns**, not when a stream it produced finishes.

A streaming route returns in milliseconds while its connection may live for hours. Ending the
request span at stream close would put hour-long SSE connections and 2 ms buffered replies in one
latency distribution, ruining both. The connection is described by `stream:open` / `stream:close`,
which carry the same `requestId` — so you can join the two yourself, and you get a meaningful
latency histogram either way.

### Streams do not emit per message

Lifecycle only. A per-message event on a high-rate stream is a firehose that costs more than it
reports, and the cost lands on the workload least able to absorb it. Instrument your own handler if
you need it, where you know what the messages mean.

## The logger

```ts
const app = createApp({ modules: [AppModule], logger: myLogger });
```

Any object with `debug`, `info`, `warn` and `error` — each taking a message and optional structured
fields. Bridging `pino` or `winston` is a few lines in either direction; core defines the shape it
needs rather than adopting anyone's.

Given none, the default writes structured JSON, or a human-readable line when the process is
attached to a TTY — decided once at boot, not per record.

**Nothing in core writes to `console`.** That is enforced by a lint rule, not by good intentions, so
every framework diagnostic is redirectable.

The logger is also injectable:

```ts
@Step({ provides: 'user', needs: ['db'] })
class LoadUser {
  run(@needs('logger') log: Logger) { … }
}
```

Same object, two access paths. It is registered rather than declared as a provider because it has to
outlive the graph on both ends: a provider cannot report its own boot failing, and shutdown warnings
happen after the graph is gone.

## Request logging

Off by default. A framework that writes to stdout uninvited is one you have to configure before you
can use it.

```ts
createApp({ modules: [AppModule], logRequests: true });
```

It is an ordinary subscriber, so you can do it by hand and take it back:

```ts
import { logRequests } from '@green-tea/core';

const stop = logRequests(app.bus, app.logger);
stop(); // removable, not merely optional
```

A logger that throws does **not** silently stop writing: the subscriber is wrapped so failures fall
back to `console`. `Bus.emit` isolates listener failures by design — an observer must never break a
request — and the wrapper keeps that guarantee without paying for it in silence.

## Metrics and tracing

There is no metrics registry in core and no OpenTelemetry exporter in core. Both read the stream
above from outside:

```ts
app.bus.on('request:end', (e) => histogram.observe(e.durationMs, { route: e.route, status: e.status }));
```

Per-step timings are already on the events, so a per-node timing breakdown needs no extra
instrumentation — the graph already knows every node.

## What it costs

**About 0.29 µs per request** — roughly **7% of the framework's own work**, or **~2% of a request
measured over a real socket**, where the transport dominates.

The cost is **per request, not per step**. Per-step timing and payload construction are skipped
entirely when nothing is subscribed, so a deep pipeline pays no more than a shallow one. What
remains is fixed: generating the request id, reading two headers, and the checks that decide
whether anyone is listening.

Absolute throughput numbers are deliberately not quoted here. The figure above comes from an
interleaved A/B — alternating both versions round by round — because the same code measured at the
start and end of one session on the same machine differed by 12% as it warmed up. Any before/after
that does not interleave is measuring the clock as much as the code.
