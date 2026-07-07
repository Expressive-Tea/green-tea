# 🍵 green-tea

> A calm, type-safe HTTP framework for Node. Your API is an explicit **dependency graph** you can see, slice, and trust — not a mutable bag threaded through positional middleware.

`@green-tea/core` — **beta**, RC-track. One runtime dependency: `reflect-metadata` (`ws` is an optional peer, only for WebSocket/mesh).

```bash
npm install @green-tea/core reflect-metadata
```

---

## The idea

Most frameworks make you keep the whole request in your head: which middleware ran, whether `req.user` exists by now, what order things fire in, which plugin quietly deleted your body parser. That mental bookkeeping is where bugs live.

green-tea puts the request on the page instead. You declare what each step **needs** and **produces**; the framework computes the order, type-checks the wiring, and can print the whole thing. A route runs only the steps its handler actually depends on. Boot fails loudly when a dependency is missing, so you never serve `undefined`.

Less to hold in your head. That's the tea.

## What's different — and why it matters

- **The pipeline is a graph, not a chain.** You never write "put this before that." You declare `needs`/`provides` and green-tea topologically sorts it. *Why it matters:* no ordering bugs, no positional guesswork, and each route runs only its slice of the graph (an auth step doesn't run on public routes).
- **The type is the contract.** What a handler reads from the context *is* its dependency list. In the typed `flow` core, a handler that reads `ctx.user` **fails to compile** if no step produces `user`. *Why it matters:* whole classes of "it was undefined in prod" disappear at compile time.
- **You can see the request before it runs.** `app.explain('/users/:id')` prints the ordered chain with origins; `app.graph()` / `GET /__graph__` render it as a live diagram. *Why it matters:* onboarding, debugging, and audits are reading, not archaeology. (NestJS puts this behind a paid Devtools plan.)
- **One primitive for real-time.** Return an `AsyncIterable` and the transport streams it — SSE, ndjson, or a WebSocket duplex — with backpressure and cleanup handled. *Why it matters:* no separate gateway, adapter, or library to bolt on.
- **A remote dependency looks like a local one.** `@needs('billing')` resolves the same whether `billing` lives in this process or on another node (mesh, experimental). *Why it matters:* no gRPC layer or message-pattern DSL to learn — there's the graph, and some nodes happen to live elsewhere.
- **Plugins can't sabotage you.** A plugin gets `bus.on(...)` (observe) and `scope.add(...)` (extend its own scope). There is no API to reorder or delete another scope's steps. *Why it matters:* installing a plugin can't break your body parser.

## Batteries included — still one dependency

Beta shipped the parts a real API needs, without growing the runtime dependency tree past `reflect-metadata`:

- **TLS → https/wss** natively, plus proxy-aware `trustProxy` (`X-Forwarded-*` → `ctx.protocol`/`ctx.ip`).
- **Secure by default.** `nosniff`, `X-Frame-Options`, `Referrer-Policy`, HSTS-when-secure — on every response, opt-out with one flag.
- **CORS** with a guarded preflight and the credentials-never-`*` rule enforced for you.
- **Validation via [Standard Schema](https://standardschema.dev).** `@body(schema)` accepts zod, valibot, or arktype — you bring the validator, the core stays zero-dep. Invalid input → `422` with per-field issues; the parsed value reaches your handler typed.
- **Real body parsing.** JSON, urlencoded, and `multipart/form-data` file uploads (`@body()` → `{ fields, files }`), size-capped (`413`) against DoS.
- **Graceful shutdown.** `app.close()` drains in-flight requests, closes live streams and mesh links.
- **Testable by construction.** `createApp({ overrides: { db: fakeDb } })` swaps any node in one line.

## Benchmarks

We built a reproducible [autocannon harness](./BENCHMARKS.md) comparing green-tea to Express 5, Fastify 5, NestJS (on both Express and Fastify), and raw Node `http` — and we wrote it to be **hard on ourselves**, not flattering.

On that harness, **green-tea handled more requests per second than every other framework in 3 of 4 scenarios** (JSON response, routing, and body-parsing-plus-validation), behind only raw `http` with no framework at all. In the fourth (a multi-step pipeline) it lands even with Fastify.

Read the honest caveats in [BENCHMARKS.md](./BENCHMARKS.md): the numbers are single-box + loopback (absolute throughput is overstated and differences compressed — trust the *ratios*), the cross-framework table runs green-tea with `security:false` for header parity, and the real cost of secure-by-default is measured separately. Regenerate any time with `npm run bench`.

## How it compares

Every framework here can serve `/users/:id`. The difference shows up as the app grows: more dependencies, real-time, and more than one machine.

| | Express | Fastify | NestJS | expressive-tea | **green-tea** |
|---|---|---|---|---|---|
| **Pipeline model** | positional `app.use()` | hooks + encapsulated plugins | DI + interceptors/guards | decorators on Express + boot stages | **explicit dependency graph (topo-sorted)** |
| **Order is decided by** | the line you wrote it on | hook phase + registration order | module/provider wiring | boot-stage order | **what each step *needs/produces*** |
| **`req.user` exists?** | hope so | hope so | if the guard ran | if the middleware ran | **boot fails if nothing provides it** |
| **Type safety** | none | schemas (runtime) | decorator types (runtime DI) | runtime | **compile-time in `flow`** + boot-validated decorators |
| **See the pipeline** | read the code | read the code | paid Devtools | `inspect` | **`explain` / `graph` / `/__graph__` — free** |
| **Real-time** | bolt on `ws`/`sse` libs | plugins | separate Gateway + adapter | separate engine | **return an `AsyncIterable`** — same primitive |
| **Cross-service calls** | HTTP client / gRPC by hand | HTTP client / gRPC | Microservices transport + message patterns | — | **`@needs('x')` resolves on another node** |
| **Plugin can break your pipeline?** | yes (deletes your body parser) | encapsulated, but hooks are global | interceptor order matters | yes | **no** — plugins only `bus.on` + `scope.add` |
| **Runtime deps** | minimal | minimal | heavy (rxjs, reflect-metadata, …) | Express + InversifyJS | **`reflect-metadata` only** (`ws` optional) |

### Read it as a story

- **Express / Fastify** — fast and battle-tested, but the request is a *mutable bag* threaded through positional middleware. Order is implicit, `req.x` is a leap of faith, and a careless plugin can delete another's work. You wire types and DI yourself.
- **NestJS** — brings DI, decorators, and structure, but the DI is *runtime token resolution*, it ships a large opinionated dependency tree, and every new capability (WebSockets, gRPC, microservices) is a **separate subsystem** with its own abstraction to learn and glue.
- **expressive-tea** — the sibling this project grew from: decorators + InversifyJS + boot stages on top of Express. green-tea keeps the ideas, drops Express and Inversify, and makes the graph — not the middleware chain — the core.
- **green-tea** — one model answers three questions other stacks answer with three subsystems: *what does this handler depend on?* → the graph; *how do I push data over time?* → an `AsyncIterable`; *how do I call another service?* → `@needs` a token that lives on another node.

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
console.log(app.explain('/api/users/:id'));  // auditable: the ordered chain, with origins
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
| `@param(...)` | route params | `()` · `('id')` · `('id', schema)` |
| `@query(...)` | parsed query string | `()` · `('q')` · `(['a','b'])` · `(schema)` |
| `@body(...)` | parsed body (JSON / urlencoded / multipart) | `()` · `('field')` · `(schema)` |
| `@headers(...)` | request headers | `()` · `('authorization')` · `(schema)` |

`@needs` keys are validated at boot: nothing provides the key → `createApp` throws with a clear error instead of serving `undefined`. Pass a Standard Schema (`@body(User)`) and the value is validated, coerced, and typed before your handler sees it.

## Two layers

1. **Typed functional core (`flow`)** — `flow().step(...).step(...).handle(...)`; step outputs accumulate into the context type (`Acc & Out`). This is where the compile-time guarantee lives.
2. **Declarative decorator layer** — `@Provider/@Step/@Module/@Route/@Get/@Transformer` + argument decorators. Emits runtime metadata, builds and topologically sorts the graph, validates at boot.

## Honest scope

green-tea is **beta**, on the road to a release candidate. Express and Fastify have a decade of ecosystem; NestJS has enterprise tooling and a huge plugin catalog. green-tea's mesh is a walking skeleton — distributed DI works, but discovery, load-balancing, and failover are not built yet. Pick green-tea for the model and the ergonomics, not the ecosystem — *yet*.

## Docs & development

- **[Quickstart](./docs/quickstart.md)** — install + concrete examples (routes/DI, `flow`, validation, uploads, SSE, WebSocket, mesh, plugins).
- **[Architecture](./docs/architecture.md)** — the mental map (layers, request lifecycle, mesh) as diagrams.

```bash
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit (includes the compile-time-guarantee type test)
npm run build      # emit dist/
npm run bench      # regenerate BENCHMARKS.md
```

## Roadmap

- ✅ **transport security** — native TLS/wss, CORS, secure-by-default headers, `trustProxy`.
- ✅ **request I/O** — JSON / urlencoded / multipart uploads, size limits, graceful shutdown, Standard Schema validation.
- ✅ **streams** — SSE / ndjson / WebSocket duplex over a multicast `AsyncIterable` channel, with backpressure and cleanup.
- ✅ **graph introspection** — `explain` / `graph` / `toMermaid` / `GET /__graph__`.
- ✅ **mesh (walking skeleton)** — `teapot`/`teacup` distributed DI over a secret-gated WS control channel. A BEAM/OTP-style cluster, *not* microservices.
- **next** — API freeze + first published release, mesh sub-specs (discovery, load-balancing, failover), runtime adapters (Deno / Bun / edge over web-standard `Request`/`Response`), official plugins.

## Versioning

green-tea uses **calendar versioning**: `YY.MM.PATCH` (e.g. `26.07.0` = the first release cut in July 2026, patch 0). A version tells you *when* it shipped; breaking changes are called out in the [CHANGELOG](./CHANGELOG.md).

## License

[MIT](./LICENSE) © green-tea contributors. Contributions require a [DCO sign-off](./CONTRIBUTING.md).
