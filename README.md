# 🍵 green-tea

> A declarative, type-safe HTTP framework for Node. The request pipeline is an explicit **dependency graph**, not a mutable middleware chain.

`@green-tea/core` — **alpha**. Zero runtime dependencies beyond `reflect-metadata` (`ws` is an optional peer dep, only for WebSocket/mesh on Node).

## Documentation

- **[Quickstart](./docs/quickstart.md)** — install + concrete examples (routes/DI, `flow`, SSE, WebSocket, mesh, plugins).
- **[Architecture](./docs/architecture.md)** — the mental map (layers, request lifecycle, mesh) as diagrams.

## Why

Express/Fastify middleware is positional, untyped, and globally mutable: order depends on the line you wrote `app.use()` on, `req.user` may or may not exist, and a plugin can quietly delete your body parser. green-tea replaces that model:

- **Declarative, not positional.** You declare what each step *needs* and *produces*. The graph order is computed at boot via topological sort — there is no "put this before that".
- **The type is the contract.** What a handler reads from the context *is* its dependency declaration. The typed `flow` core makes a handler that reads `ctx.user` **fail to compile** if no step produces `user`.
- **Structural plugin isolation.** Plugins get only `bus.on(...)` (observe) and `scope.add(...)` (extend their own scope). There is no API to reorder or delete another scope's steps.
- **Response = return value.** No `Response.json()`. Return data; a `@Transformer` serializes it in a leave phase. Cut a request by `throw`ing a typed signal.
- **Fail-fast boot.** A required provider that can't initialize (e.g. the DB) stops the server from serving — no 500s because a resource wasn't ready.

## How it compares

Every framework here can serve `/users/:id`. The difference is what happens when the app
grows: more dependencies, real-time, and more than one machine.

| | Express | Fastify | NestJS | expressive-tea | **green-tea** |
|---|---|---|---|---|---|
| **Pipeline model** | positional `app.use()` | hooks + encapsulated plugins | DI + interceptors/guards | decorators on Express + boot stages | **explicit dependency graph (topo-sorted)** |
| **Order is decided by** | the line you wrote it on | hook phase + registration order | module/provider wiring | boot-stage order | **what each step *needs/produces*** |
| **`req.user` exists?** | hope so | hope so | if the guard ran | if the middleware ran | **boot fails if nothing provides it** |
| **Type safety** | none | schemas (runtime) | decorator types (runtime DI) | runtime | **compile-time in `flow`** + boot-validated decorators |
| **Response** | `res.send()` (mutate) | `reply.send()` | return value | return value | **return value → `@Transformer`** |
| **Real-time** | bolt on `ws`/`sse` libs | plugins | separate Gateway + adapter | separate engine | **return an `AsyncIterable`** — same primitive |
| **Cross-service calls** | HTTP client / gRPC by hand | HTTP client / gRPC | Microservices transport + message patterns | — | **`@needs('x')` resolves on another node** |
| **Plugin can break your pipeline?** | yes (deletes your body parser) | encapsulated, but hooks are global | interceptor order matters | yes | **no** — plugins only `bus.on` + `scope.add` |
| **Runtime deps** | minimal | minimal | heavy (rxjs, reflect-metadata, …) | Express + InversifyJS | **`reflect-metadata` only** (`ws` optional) |

### Read it as a story

- **Express / Fastify** — fast and battle-tested, but the request is a *mutable bag* threaded
  through positional middleware. Order is implicit, `req.x` is a leap of faith, and a careless
  plugin can delete another's work. You wire types and DI yourself.
- **NestJS** — brings DI, decorators, and structure, but the DI is *runtime token resolution*,
  it's a large opinionated dependency tree, and every new capability (WebSockets, gRPC,
  microservices) is a **separate subsystem** with its own abstraction (Gateways, transports,
  message patterns) to learn and glue.
- **expressive-tea** — the sibling this project grew from: decorators + InversifyJS DI + boot
  stages on top of Express. green-tea keeps the ideas, drops Express and Inversify, and makes
  the graph — not the middleware chain — the core.
- **green-tea** — one model answers three questions other stacks answer with three subsystems:
  - *"what does this handler depend on?"* → the graph (boot-validated, `flow` checks it at compile time)
  - *"how do I push data over time?"* → return an `AsyncIterable` (SSE / WebSocket, one primitive)
  - *"how do I call another service?"* → `@needs` a token that lives on another node (mesh)

  A remote dependency looks **identical** to a local one. There is no gRPC layer, no
  message-pattern DSL, no separate WebSocket gateway — there is the graph, and some of its
  nodes happen to live on another machine.

### Honest scope

green-tea is **alpha**. Express/Fastify have a decade of ecosystem; NestJS has enterprise
tooling and a huge plugin catalog. Mesh discovery, load-balancing, and failover are not built
yet (the [walking skeleton](./docs/quickstart.md#5-mesh--distributed-dependency-injection) is).
Pick green-tea for the model, not the ecosystem — *yet*.

## Quick look

```typescript
import {
  createApp, Provider, Step, Route, Get, Module,
  Transformer, JsonTransformer, Unauthorized, needs, param,
} from '@green-tea/core';

@Provider({ provides: 'db' })
class Database {
  provide() {
    const users = { u1: { id: 'u1', name: 'Diego' } };
    return { db: { find: (token: string) => users[token] ?? null } };
  }
}

@Step({ provides: 'user', needs: ['db', 'req'] })
class Authenticate {
  run(ctx) {
    const user = ctx.db.find(ctx.req.headers['x-token']);
    if (!user) throw new Unauthorized('invalid token');   // cut the request
    return { user };                                       // continue
  }
}

@Route('/users')
class UserController {
  @Get('/:id')
  @Transformer(JsonTransformer)
  getUser(@needs('user') user, @param('id') id) {          // the signature IS the contract
    return { requested: id, you: user };
  }
}

@Module({ mountpoint: '/api', providers: [Database], steps: [Authenticate], controllers: [UserController] })
class ApiModule {}

const app = createApp({ modules: [ApiModule] });
console.log(app.inspect('/api/users/:id'));  // auditable: ordered chain with origins
app.listen(3000);
```

```bash
curl -H 'x-token: u1' http://localhost:3000/api/users/9
# {"requested":"9","you":{"id":"u1","name":"Diego"}}
```

## Argument decorators

The handler signature declares exactly what it wants — in any order, nothing more.

| Decorator | Injects | Forms |
|---|---|---|
| `@needs('user')` | a graph-produced value (boot-validated) | `('key')` |
| `@ctx()` | the whole accumulated context | `()` |
| `@param(...)` | route params | `()` · `('id')` · `(['a','b'])` |
| `@query(...)` | parsed query string | `()` · `('q')` · `(['a','b'])` |
| `@body(...)` | parsed JSON body | `()` · `('field')` · `(['a','b'])` |
| `@headers(...)` | request headers | `()` · `('authorization')` · `(['a','b'])` |

`@needs` keys are validated at boot: if nothing provides the key, `createApp` throws with a clear error instead of serving `undefined`.

## Two layers

1. **Typed functional core (`flow`)** — `flow().step(...).step(...).handle(...)`; step outputs accumulate into the context type (`Acc & Out`). This is where the compile-time guarantee lives.
2. **Declarative decorator layer** — `@Provider/@Step/@Module/@Route/@Get/@Transformer` + argument decorators. Emits runtime metadata, builds and topologically sorts the graph, validates at boot.

## Benchmarks

Reproducible autocannon comparison vs Express 5, Fastify 5, and raw Node `http`
lives in [BENCHMARKS.md](./BENCHMARKS.md) (regenerate with `npm run bench`).

Numbers are single-box + loopback — absolute req/s is overstated and
inter-framework differences are compressed; treat cross-framework *ratios* as
the honest signal, not the raw throughput. The cross-framework table runs
green-tea with `security:false` for header parity; the real cost of green-tea's
secure-by-default headers/validation is measured separately in that file.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit (includes the compile-time-guarantee type test)
npm run build     # emit dist/
```

## Roadmap

- ✅ **streams** — SSE / ndjson / WebSocket duplex over a multicast `AsyncIterable` channel. Return an `AsyncIterable` and the transport streams it (backpressure + cleanup). See the [quickstart](./docs/quickstart.md#3-streaming--sse).
- ✅ **mesh (walking skeleton)** — `teapot`/`teacup`: a consumer resolves a scope/step or proxies a route living on another node, over a secret-gated WS control channel, via one id-correlated RPC. Remote tokens become synthetic graph nodes. Model: a BEAM/OTP-style cluster, *not* microservices. See the [quickstart](./docs/quickstart.md#5-mesh--distributed-dependency-injection).
- **mesh sub-specs (next)** — discovery/auto-registration, 2-way load-balancing, failover/health.
- **runtime adapters** — factor the transport behind an adapter so the core stays runtime-agnostic; Node / Deno / Bun / edge become thin adapters over web-standard `Request`/`Response`. Only `src/http.ts` is runtime-specific today.
- official plugins (cors, body parsers, auth) — structurally unable to sabotage the global pipeline.

## License

[MIT](./LICENSE) © green-tea contributors. Contributions require a [DCO sign-off](./CONTRIBUTING.md).
