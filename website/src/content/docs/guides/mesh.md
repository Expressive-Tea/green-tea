---
title: Mesh (alpha)
description: "Distributed dependency injection over a secret-gated WebSocket control channel."
---

:::caution[Alpha]
Mesh is **alpha** — its API and wire protocol may change between releases, and discovery, load-balancing, and failover are not built. It is gated behind an explicit opt-in: `createApp({ mesh, experimental: true })`, and `createApp` **throws** if you configure `mesh` without `experimental: true`. **Don't ship mesh to production yet.**
:::

A **teacup** can depend on a token that physically lives on another node — a **teapot**. `@needs('billing')` resolves the same whether `billing` runs in this process or on a remote one. There's no gRPC layer or message-pattern DSL: there's the [graph](/concepts/the-graph/), and some nodes happen to live elsewhere.

Exports are opt-in (`export: true`) and the control channel is gated by a shared secret.

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

Remote tokens become synthetic nodes in the local graph with RPC-backed runners, so the rest of the pipeline is unchanged. For non-mesh apps `createApp` stays synchronous; mesh apps defer graph finalization to `listen()` so remote scopes can join first.

:::note[Skeleton limitations (by design)]
No discovery, load-balancing, or failover yet; app-scope remote values are not reconciled on reconnect; the request envelope omits `req.url`.
:::
