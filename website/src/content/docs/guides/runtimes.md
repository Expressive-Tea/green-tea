---
title: Runtimes (Node, Deno, Bun, edge)
description: "Run Green Tea anywhere with app.fetch — the Web-Standards handler."
---

Green Tea exposes a Web-Standards handler, `app.fetch(request): Promise<Response>`, so the
same app runs on any runtime that speaks the Fetch API — for **HTTP and SSE** today.

```ts
const app = createApp({ modules: [ApiModule] });

// Node (native listener, TLS, timeouts)
app.listen(3000);

// Deno
Deno.serve(app.fetch);

// Bun
Bun.serve({ fetch: app.fetch });

// Cloudflare / edge
export default { fetch: app.fetch };
```

**Node is the reference implementation** — every runtime returns the same status, headers,
and body for the same request (enforced by a parity test suite).

**Not yet on Bun/edge runtimes:** WebSocket (`@Ws`) and mesh — still Node-only there; Deno now
has WebSocket support via `serveDeno` (see below). `app.listen()` and TLS remain Node-only; on
Deno/Bun/edge you get `app.fetch`.

**Body-size enforcement differs slightly:** on `app.fetch`, an oversized body is read in full
before the `413` is returned, whereas Node aborts mid-stream once the limit is hit — so on
non-Node runtimes, also bound request size at the platform/runtime layer.

## WebSocket on Deno

`app.fetch` covers HTTP + SSE on every runtime. WebSocket needs a runtime-specific
upgrade, so Deno gets a dedicated adapter at `@green-tea/core/deno`:

```ts
import { createApp } from '@green-tea/core';
import { serveDeno } from '@green-tea/core/deno';

const app = createApp({ modules: [ChatModule] });

// HTTP + SSE via app.fetch, WebSocket via Deno.upgradeWebSocket — one call:
serveDeno(app, { port: 8000 });
```

`serveDeno` routes normal requests through `app.fetch` and WebSocket upgrades through
`app.upgrade` — the same graph, the same `@Ws` handlers, the same rooms/channels you
run on Node. Behaviour matches the Node reference.

**Advanced:** `app.upgrade(request, socket)` is the neutral primitive `serveDeno` uses.
Any runtime can build a `WsSocket` capability (`inbound`, `abort`, `isOpen`, `send`,
`close`, `terminate`) and drive the graph — this is how Bun and edge support will land.

**Still Node-only:** `app.listen()`, TLS, per-request timeouts, and mesh. On Deno you
get `app.fetch` + `serveDeno`.
