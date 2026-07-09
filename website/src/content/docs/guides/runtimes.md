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

**Not yet on non-Node runtimes:** WebSocket (`@Ws`) and mesh — Node-only for now; cross-runtime
WebSocket is on the roadmap. `app.listen()` and TLS are Node-only; on Deno/Bun/edge you get
`app.fetch`.
