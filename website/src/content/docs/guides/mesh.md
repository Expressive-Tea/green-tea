---
title: Mesh (alpha)
description: "Distributed dependency injection over a secret-gated WebSocket control channel."
---

:::caution[Alpha]
Mesh is **alpha** — its API and wire protocol may change between releases, and discovery, load-balancing, and failover are not built. It is gated behind an explicit opt-in: `createApp({ mesh, experimental: true })`, and `createApp` **throws** if you configure `mesh` without `experimental: true`. **Don't ship mesh to production yet.**
:::

A **teacup** can depend on a token that physically lives on another node — a **teapot**. `@needs('billing')` resolves the same whether `billing` runs in this process or on a remote one. There's no gRPC layer or message-pattern DSL: there's the [graph](/concepts/the-graph/), and some nodes happen to live elsewhere.

Exports are opt-in (`export: true`) and the control channel is gated by a shared secret.

## What runs where

Mesh runs on **Node, Deno and Bun**, as both teapot and teacup, in any combination — a Deno teapot can serve a Node teacup. The wire is JSON over a WebSocket, so peers only have to agree on the protocol version, not the runtime.

**Edge (Cloudflare Workers) is not supported.** The teapot's secret comparison uses `node:crypto`'s `timingSafeEqual`, which workerd's `nodejs_compat` does not provide.

You do **not** need `listen()`. The graph boots on first use, so `Deno.serve`/`Bun.serve` work through `app.fetch`/`app.upgrade` like any other route:

```typescript
serveDeno(teapot, { port: 3002 });   // control channel served via app.upgrade
serveBun(teacup, { port: 3003 });    // teapots connected on the first request
```

## Node A — teapot (exposes `config`, `auth`, and a route)

```typescript
@Provider({ provides: 'config', export: true })
class Config { provide() { return { config: { region: 'mx', tier: 'pro' } }; } }

@Step({ provides: 'auth', needs: [], export: true })
class Auth { run(ctx: any) { return { auth: { token: ctx.headers?.['x-token'] ?? 'anon' } }; } }

@Route('/svc')
class Svc { @Get('/ping', { export: true }) ping() { return { pong: true }; } }

@Module({ mountpoint: '/api', providers: [Config], steps: [Auth], controllers: [Svc] })
class TeapotModule {}

const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: 'shh' } });
await teapot.listen(3002);
```

## Node B — teacup (uses `config` + `auth` with no local providers)

```typescript
@Route('/local')
class LocalCtl {
  @Get('/who')
  who(@needs('config') config: any, @needs('auth') auth: any) {
    return { config, auth };           // both resolved by RPC to the teapot
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

const teacup = createApp({
  modules: [TeacupModule],
  experimental: true,
  mesh: { teapots: [{ url: 'ws://A-host:3002/__mesh__/control', secret: 'shh' }] },
});
await teacup.listen(3003);
// GET B:3003/api/local/who  (x-token: abc)
//   → { "config": { "region": "mx", "tier": "pro" }, "auth": { "token": "abc" } }
```

## How it resolves

`@needs('config' | 'auth')` validates at boot because the teapot announced them in its **manifest** on connect. Scope determines the RPC cost:

- A **provider** export is **app-scope** — resolved once and cached.
- A **step** export is **request-scope** — one RPC per request, carrying the request envelope.

Remote tokens become synthetic nodes in the local graph with RPC-backed runners, so the rest of the pipeline is unchanged. For non-mesh apps `createApp` stays synchronous; a mesh app defers graph finalization until it boots — connecting to teapots is network I/O — and boots on whichever comes first: `app.fetch`, `app.upgrade` or `listen()`. Whoever triggers it, it happens once.

## Inspecting a mesh graph

`inspect()`, `graph()` and `explain()` are synchronous, but a mesh graph is not knowable until its teapots have been asked — so on a mesh app they throw until the graph is resolved. `await app.ready()` resolves it:

```typescript
await app.ready();       // connects the teapots; a no-op on a non-mesh app
app.graph();             // now includes the remote scopes
```

Write those two lines and your code works against either kind of app without knowing which it got. `ready()` deliberately does **not** boot providers — resolving the graph and being ready to serve are different things, and drawing a diagram should not open your database connections. Serving (`fetch`/`upgrade`/`listen`) boots them too and shares the same memoized step, so calling both never resolves the graph twice.

The dev routes (`/__graph__`, `/__openapi__`) need none of this: a request boots the app before the route runs.

## Buffered routes only

Mesh proxies **buffered** endpoints. `@Sse`, `@Stream` and `@Ws` routes are not exportable: a remote route is registered as `transport: 'buffer'`, and a handler that returns an `AsyncIterable` over a mesh call fails with `cannot proxy a streaming route`. Streams are a live socket between client and server; there is no meaningful way to relay one through an RPC hop today.

## One teapot per route

A route must be exported by exactly **one** teapot. If two export the same `method + pattern`, the boot **fails**, naming the route and both teapots:

```
mesh: route 'GET /api/svc/ping' is exported by more than one teapot
(ws://a/__mesh__/control and ws://b/__mesh__/control) — load balancing across
teapots is not implemented yet, so green-tea will not choose one for you.
```

This is a hard error rather than a silent pick because there is no load balancing to fall back on: choosing one would be an arbitrary answer you could come to depend on. Scope tokens (`@Provider`/`@Step`) are unique for the same reason — and balancing them would be meaningless anyway, since an app-scope export is resolved once and cached.

**Local routes win.** If you declare a route locally *and* import it from a teapot, yours takes precedence — that is how you override a teapot — and green-tea warns so a shadowed export doesn't look like a broken one:

```
[green-tea] mesh: route 'GET /api/svc/ping' is exported by teapot ws://a/… but also
declared locally — the local route takes precedence and the remote one will not be
reached. Remove one if that is not what you meant.
```

## Protocol version

Peers are separate processes on separate deploy cadences, so the wire is versioned: `MESH_PROTOCOL_VERSION` travels in the `hello` and `manifest` frames, and a mismatch is refused on both sides with both versions named. A teapot checks the version **before** the secret — a skewed peer is not an authentication failure, and reporting it as one would send you hunting the wrong bug.

Bump the version and old peers refuse the connection loudly instead of misreading a frame.

:::note[Skeleton limitations (by design)]
No discovery, load-balancing, or failover yet; app-scope remote values are not reconciled on reconnect; the request envelope omits `req.url`.
:::
