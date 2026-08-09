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

**Node is the reference implementation.** A parity suite pins `app.fetch` to Node's native
listener — identical status, headers, and body for the same request. The other runtimes drive
that *same* `app.fetch` / `app.upgrade` core, so they inherit that behaviour rather than
re-implementing it, and each carries its own smoke tests: Deno and Bun cover WebSocket and mesh,
and edge runs against real workerd (Miniflare).

**All four runtimes now have full WebSocket support:** Node via `app.listen()`, Deno and Bun via
`serveDeno` / `serveBun`, and Cloudflare Workers / edge via `edgeHandler` (see below) — same graph,
same `@Ws` handlers, same rooms/channels everywhere. `app.listen()`, TLS and per-request timeouts
remain Node-only; on Deno/Bun/edge you get `app.fetch` + the runtime's adapter. **Mesh (alpha)
runs on Node, Deno and Bun** — teapot and teacup, in any combination — but not on edge.

**Connection-limit enforcement is Node-only:** `limits.maxConnections` defaults to `1000` and
maps to Node's `server.maxConnections` when the app runs through `app.listen()`. `Deno.serve` and
`Bun.serve` expose no equivalent active-socket cap, so `serveDeno` and `serveBun` cannot enforce
this option. Apply the connection limit at the deployment platform or reverse proxy on those
runtimes.

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
`close`, `terminate`) and drive the graph — `serveBun` and `edgeHandler` build on the
same primitive (see below).

**Still Node-only:** `app.listen()`, TLS and per-request timeouts. On Deno you get
`app.fetch` + `serveDeno`. [Mesh](/docs/guides/mesh/) works here: the control channel is
served through `app.upgrade` and the teacup connects with Deno's global `WebSocket`.

## WebSocket on Bun

`app.fetch` covers HTTP + SSE on every runtime. WebSocket needs a runtime-specific
upgrade, so Bun gets a dedicated adapter at `@green-tea/core/bun`:

```ts
import { createApp } from '@green-tea/core';
import { serveBun } from '@green-tea/core/bun';

const app = createApp({ modules: [ChatModule] });

// HTTP + SSE via app.fetch, WebSocket via Bun's server-level handler — one call:
serveBun(app, { port: 8000 });
```

`serveBun` routes normal requests through `app.fetch` and WebSocket upgrades through
`app.upgrade` — the same graph, the same `@Ws` handlers, the same rooms/channels you
run on Node and Deno. Behaviour matches the Node reference.

**Still Node-only:** `app.listen()`, TLS and per-request timeouts. On Bun you get
`app.fetch` + `serveBun`. [Mesh](/docs/guides/mesh/) works here too.

## Cloudflare Workers / edge

`app.fetch` covers HTTP + SSE on every runtime. WebSocket needs a runtime-specific
upgrade, so Cloudflare Workers get a dedicated adapter at `@green-tea/core/edge`:

```ts
import { createApp } from '@green-tea/core';
import { edgeHandler } from '@green-tea/core/edge';

const app = createApp({ modules: [ChatModule] });

export default { fetch: edgeHandler(app) };
```

`edgeHandler` routes normal requests through `app.fetch` and WebSocket upgrades through
`WebSocketPair` and `app.upgrade` — the same neutral primitive `serveDeno` and `serveBun`
use. Same graph, same `@Ws` handlers, same rooms/channels as Node/Deno/Bun; behaviour
matches the Node reference; validated on real workerd (Miniflare).

**Requirement:** the Worker must enable the `nodejs_compat` compatibility flag —
`wrangler.toml`:

```toml
compatibility_flags = ["nodejs_compat"]
compatibility_date = "2024-09-23" # or later
```

Green Tea's core statically imports Node built-ins that workerd only provides under
this flag; without it, the Worker fails to load.

**Still Node-only:** `app.listen()`, TLS and per-request timeouts. [Mesh](/docs/guides/mesh/)
is **not** supported on edge: the teapot's secret comparison needs `node:crypto`'s
`timingSafeEqual`, which `nodejs_compat` does not provide. Cloudflare's
Durable Objects and WebSocket Hibernation are **not** used — `edgeHandler` accepts
WebSockets with the standard `WebSocketPair` model, so a Worker holds the connection
open for its lifetime rather than hibernating between messages.

## Filesystem features — Node/Deno/Bun only

A few [HTML & views](/docs/guides/html/) features read from disk, so they need a runtime with
a filesystem:

- `@Html('file.html')` — reads and caches the file at boot.
- `@Html('file.html', { template: true })` — same, then renders it per request.
- `createApp({ static })` — serves a directory of files.

All three throw at boot (`createApp()`/route-build time) on a runtime without a
filesystem, rather than failing per-request. On the edge, use bare `@Html` returning a
string instead — pair it with the exported `render` over a template string you `import`
as a module (so it ships in the bundle, no disk read), and serve other assets (images,
CSS, JS) from a CDN in front of the Worker.
