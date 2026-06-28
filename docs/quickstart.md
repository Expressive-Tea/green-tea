# green-tea — Quickstart

A type-safe HTTP framework where the request/boot pipeline is an explicit **dependency
graph**. You declare what you need; the framework computes the order, validates it at boot,
and can extend the graph over time (streams) and across machines (mesh).

See [architecture.md](./architecture.md) for the mental map.

## Install

```bash
npm install @green-tea/core reflect-metadata
# ws is an OPTIONAL peer dependency — only needed for WebSocket / mesh on Node:
npm install ws            # optional
```

`tsconfig.json` must enable decorator metadata:

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "target": "es2017",
    "module": "commonjs"
  }
}
```

Import `reflect-metadata` once at your entrypoint.

## 1. A route with dependency injection

A **provider** is an app-scope singleton. A **step** runs per request and transforms the
context. A handler's **argument decorators are its dependency declaration** — ask for what
you want, in any order. If you `@needs` a token nothing produces, you get a **boot error**,
not an `undefined` at runtime.

```typescript
import 'reflect-metadata';
import { createApp, Provider, Step, Route, Get, Module, Unauthorized, needs, param } from '@green-tea/core';

@Provider({ provides: 'db' })
class Database {
  provide() { return { db: { find: (id: string) => ({ id, name: 'Diego' }) } }; }
}

@Step({ provides: 'user', needs: ['db', 'req'] })
class Authenticate {
  run(ctx: any) {
    const user = ctx.db.find(ctx.req.headers['x-token']);
    if (!user) throw new Unauthorized('bad token'); // throw = short-circuit the pipeline
    return { user };                                // return = continue, merge into ctx
  }
}

@Route('/users')
class UserController {
  @Get('/:id')
  getUser(@needs('user') user: any, @param('id') id: string) {
    return { requested: id, you: user };           // auto-serialized as JSON
  }
}

@Module({ mountpoint: '/api', providers: [Database], steps: [Authenticate], controllers: [UserController] })
class ApiModule {}

const app = createApp({ modules: [ApiModule] });
await app.listen(3000);
// GET /api/users/9  (header x-token) → { "requested": "9", "you": { "id": "...", "name": "Diego" } }

await app.close();   // graceful shutdown: drains in-flight requests, closes streams + mesh links
```

> **Per-route execution (important).** Each route runs **only the providers/steps in the transitive
> closure of its handler's `@needs`** — nothing else. A route that doesn't `@needs('user')` does **not**
> run the `Authenticate` step. This means a cross-cutting *enforcement* step (e.g. auth that throws 401)
> only protects routes that actually `@needs` its token. To run something on **every** route regardless
> of needs (logging, audit, a global guard), add it as a **plugin step** via `scope.add({ ..., provides: [] })` —
> steps that produce nothing run unconditionally. Don't rely on a token-providing step to guard routes
> that don't declare it.

### Argument decorators

| Decorator | Reads from | Adds a graph dependency? |
|---|---|---|
| `@needs('user')` | a value produced by a provider/step | **yes** (boot-validated) |
| `@ctx()` | the whole accumulated context | no |
| `@param('id')` | route params | no |
| `@query('q')` | parsed query string | no |
| `@body()` | parsed JSON body | no |
| `@headers('x')` | request headers | no |
| `@inbound()` | the incoming WS message channel | no (WS only) |
| `@abort()` | an `AbortSignal` that fires on disconnect | no (stream/WS) |

Each envelope decorator has three forms: `@query()` (whole object), `@query('q')` (one key),
`@query(['q','date'])` (subset).

## 2. Compile-time guarantee with `flow`

The decorator layer validates the graph at boot. The functional core `flow` validates it in
the **type checker**:

```typescript
import { flow } from '@green-tea/core';

const pipeline = flow()
  .step('db', () => ({ find: (id: string) => id }))
  .step('user', (ctx) => ctx.db.find('u1')); // referencing a missing 'db' would not compile
```

## 3. Streaming — SSE

Return an `AsyncIterable` and the pipeline streams it (the transformer is bypassed; the
transport frames it, handles backpressure, and cleans up on disconnect).

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

`@Stream(path)` negotiates the transport by header (`Accept: text/event-stream` → SSE,
`Upgrade: websocket` → WS, else ndjson chunked).

## 4. Streaming — WebSocket duplex

A WS handler receives the **inbound** channel and returns the **outbound** channel — a step
that consumes one channel and produces another.

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

`channel<T>()` is a multicast `AsyncIterable` with `push` / `close` / `fail` and an optional
bounded buffer (`channel({ buffer: 100 })`, drop-oldest).

## 5. Mesh — distributed dependency injection

A **teacup** can depend on a token that physically lives on a **teapot**. Exports are
opt-in (`export: true`) and the control channel is gated by a shared secret.

**Node A — teapot (exposes `config`, `auth`, and a route):**

```typescript
@Provider({ provides: 'config', export: true })
class Config { provide() { return { config: { region: 'mx', tier: 'pro' } }; } }

@Step({ provides: 'auth', needs: [], export: true })
class Auth { run(ctx: any) { return { auth: { token: ctx.headers?.['x-token'] ?? 'anon' } }; } }

@Route('/svc')
class Svc { @Get('/ping', { export: true }) ping() { return { pong: true }; } }

@Module({ mountpoint: '/api', providers: [Config], steps: [Auth], controllers: [Svc] })
class TeapotModule {}

const teapot = createApp({ modules: [TeapotModule], mesh: { secret: 'shh' } });
await teapot.listen(3002);
```

**Node B — teacup (uses `config` + `auth` with no local providers):**

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
  mesh: { teapots: [{ url: 'ws://A-host:3002/__mesh__/control', secret: 'shh' }] },
});
await teacup.listen(3003);
// GET B:3003/api/local/who  (x-token: abc)
//   → { "config": { "region": "mx", "tier": "pro" }, "auth": { "token": "abc" } }
```

`@needs('config' | 'auth')` validates at boot because the teapot announced them in its
manifest on connect. A provider export is app-scope (resolved once, cached); a step export is
request-scope (RPC per request, carrying the request envelope).

> Skeleton limitations (by design): no discovery, load-balancing, or failover yet; app-scope
> remote values are not reconciled on reconnect; the request envelope omits `req.url`.

## 6. Plugins & observability

```typescript
const logger = (api: any) => {
  api.bus.on('request:step:enter', (p: any) => console.log(`→ ${p.name}`));
  api.bus.on('stream:open', (p: any) => console.log(`stream open ${p.name}`));
  api.bus.on('mesh:rpc:error', (p: any) => console.error('mesh rpc failed', p.error));
};

const app = createApp({ modules: [ApiModule], plugins: [logger] });
```

Lifecycle events: `boot:provider:*`, `request:step:*`, `stream:open|close|error`,
`mesh:connect|disconnect|rpc:error`, `plugin:mounted`.

## The one rule to remember

```
return a VALUE          → buffered response (transformer → JSON)
return an AsyncIterable → stream (SSE / WS)
@needs a remote token   → RPC to a teapot (mesh)
```
