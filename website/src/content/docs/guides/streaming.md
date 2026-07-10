---
title: Streaming & real-time
description: "SSE, ndjson, and WebSocket duplex from one AsyncIterable primitive."
---

Most stacks treat "push data over time" as a bolt-on: Express reaches for a `ws` or SSE library, Fastify for a plugin, NestJS for a separate **WebSocket Gateway** with its own adapter and decorators. That's a second mental model, a second error surface, glued to your HTTP app.

green-tea has one model: an **`AsyncIterable`**. A handler that returns a sequence of values over time *is* a stream — the same shape you'd return from any function. You **declare the mode** with a decorator; the framework handles framing, backpressure, cleanup, and disconnects.

## One primitive, four modes

| Declare | Direction | Transport | Reach for it when |
|---|---|---|---|
| `@Sse` | server → client | `text/event-stream` | live updates to a browser (`EventSource`) |
| `@Ws` | duplex | WebSocket | chat, collaboration — anything two-way |
| `@Stream` | negotiated | SSE / ndjson / WS, picked from the client's `Accept` / `Upgrade` | one handler, the client chooses |
| *(plain return)* | server → client | SSE or ndjson by `Accept` | programmatic streaming over `fetch` |

The primitive never changes — it's always an `AsyncIterable`. What changes is **direction and framing**, and you declare which. That's the difference between each iterable green-tea hands you:

- **`@Sse` / plain return** — you return **one** iterable: the *outbound* stream. Each `yield` becomes an SSE event, or an ndjson line.
- **`@Ws` (duplex)** — **two** iterables. `@inbound()` gives you the client's *incoming* messages to consume; the one you **return** is the *outbound* stream to the client. `@abort()` hands you an `AbortSignal` for teardown.
- **`@Stream`** — you write the handler once; the client's request decides whether it arrives as SSE, ndjson, or a WebSocket. No branching in your code.

:::note
Streaming bypasses the response transformer — the transport frames each value directly, handles backpressure, and cleans up on disconnect. See [arguments](/guides/arguments/) for the full list of argument decorators, including the stream-only `@inbound()` and `@abort()`.
:::

## Streaming — SSE

Return an `AsyncIterable` and the pipeline streams it (the transformer is bypassed; the transport frames it, handles backpressure, and cleans up on disconnect).

```typescript
import { Route, Sse } from '@green-tea/core';

@Route('/feed')
class FeedController {
  @Sse('/ticks')
  ticks() {
    return (async function* () {
      for (let n = 1; n <= 3; n++) yield { tick: n };
    })();
  }
}
// GET /feed/ticks  (Accept: text/event-stream)
//   data: {"tick":1}
//   data: {"tick":2}
//   data: {"tick":3}
```

`@Stream(path)` negotiates the transport by header (`Accept: text/event-stream` → SSE, `Upgrade: websocket` → WS, else ndjson chunked).

## Streaming — WebSocket duplex

A WS handler receives the **inbound** channel and returns the **outbound** channel — a step that consumes one channel and produces another.

```typescript
import { Route, Ws, inbound, channel } from '@green-tea/core';

@Route('/chat')
class ChatController {
  @Ws('/echo')
  echo(@inbound() incoming: AsyncIterable<string>) {
    const out = channel<string>();
    (async () => {
      for await (const msg of incoming) out.push(`echo: ${msg}`);
      out.close();
    })();
    return out;
  }
}
```

`channel<T>()` is a multicast `AsyncIterable` with `push` / `close` / `fail` and an optional bounded buffer (`channel({ buffer: 100 })`, drop-oldest).

:::note[WebSocket needs the `ws` peer]
`@Ws` (and mesh) require the optional [`ws`](https://github.com/websockets/ws) peer dependency — `npm i ws`. SSE, ndjson, and plain HTTP need nothing extra.
:::

## Fan-out — `channel()` and `rooms`

Fan-out is a primitive too: `channel()` is a **multicast** `AsyncIterable` (bounded, drop-oldest) so one source feeds many subscribers, and `rooms` are named broadcast hubs — publish once, every connection in the room receives it.

```typescript
@Route('/live')
class Live {
  @Sse('/prices')                                   // one iterable out — each yield is an event
  prices() {
    return (async function* () {
      while (true) { yield { btc: await getPrice() }; await sleep(1000); }
    })();
  }

  @Ws('/echo')                                      // duplex — consume @inbound, return the outbound stream
  echo(@inbound() incoming: AsyncIterable<string>) {
    const out = channel<string>();
    (async () => { for await (const m of incoming) out.push(`echo: ${m}`); out.close(); })();
    return out;
  }
}
```

Same `@Route`, same handler shape, same `AsyncIterable` — real-time is not a separate framework you also have to learn.

`rooms` is the built-in shared `Rooms` primitive (one instance app-wide). A typical chat handler pumps the `@inbound()` channel into `rooms.room(name)` and returns that same room as its outbound channel, so every joined socket multicasts to the others. A handshake `@Step` can read `?token=` and throw `Unauthorized` — which closes the socket with code **4401** (`4000 + status`). See [security](/guides/security/) for handshake authentication.

## Transport is declared, not inferred

A route streams **because** it's declared `@Sse`, `@Stream`, or `@Ws` — never because a handler happened to return an `AsyncIterable`. In most frameworks the return type decides the wire format; in green-tea the decorator decides, and the return value is enforced against it:

| Declare | Handler must return | Otherwise |
|---|---|---|
| `@Get` / `@Post` / `@Put` / `@Patch` / `@Delete` (buffered) | a value | returning an `AsyncIterable` fails with a 500 `TransportMismatchError` |
| `@Sse` / `@Ws` (streaming) | an `AsyncIterable` | returning a plain value fails with a 500 `TransportMismatchError` |
| `@Stream` (negotiate) | either | the client picks via `Accept` / `Upgrade` — no mismatch |

This is the anti-Express guarantee: your wire contract is what you **declared**, never a surprise sprung by a return value. A buffered route can't accidentally start streaming because someone returned a generator; a streaming route can't silently downgrade to a buffered response because someone forgot a `yield`. Declare `@Sse` / `@Stream` / `@Ws` to stream — the return value never changes a route's transport.
