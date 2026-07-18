<p align="center">
  <img src="./assets/logo.png" width="112" alt="Green Tea" />
</p>

<h1 align="center">Green&nbsp;Tea.</h1>

<p align="center"><b>A zen, opinionated, type-safe framework.</b></p>

<p align="center">
  Your API is an explicit <b>dependency graph</b> you can see, slice, and trust —<br />
  not a mutable bag threaded through positional middleware. <i>That's the tea.</i> 🍵
</p>

`@green-tea/core` — **beta**, RC-track. One runtime dependency: `reflect-metadata`. Two optional peers you install only if you use them: `ws` (WebSocket / mesh) and `busboy` (multipart uploads).

```bash
npm install @green-tea/core reflect-metadata
# optional, only if you use them:
npm install ws       # WebSocket routes (@Ws) and mesh
npm install busboy   # multipart/form-data file uploads
```

---

## The idea

Most frameworks make you keep the whole request in your head: which middleware ran, whether `req.user` exists by now, what order things fire in, which plugin quietly deleted your body parser. That mental bookkeeping is where bugs live.

green-tea puts the request on the page instead. You declare what each step **needs** and **produces**; the framework computes the order, type-checks the wiring, and can print the whole thing. A route runs only the steps its handler actually depends on. Boot fails loudly when a dependency is missing, so you never serve `undefined`.

Less to hold in your head. That's the tea.

## What's different — and why it matters

- **The pipeline is a graph, not a chain.** You never write "put this before that." You declare `needs`/`provides` and green-tea topologically sorts it. *Why it matters:* no ordering bugs, no positional guesswork, and each route runs only its slice of the graph (an auth step doesn't run on public routes).
- **The type is the contract.** What a handler reads from the context *is* its dependency list. In the typed `flow` core, a handler that reads `ctx.user` **fails to compile** if no step produces `user`. *Why it matters:* whole classes of "it was undefined in prod" disappear at compile time.
- **You can see the request before it runs.** `app.explain('/users/:id')` prints the ordered chain with origins; `app.graph()` / `GET /__graph__` render it as a live diagram; `app.openapi()` projects the same metadata into an OpenAPI 3.1 spec. *Why it matters:* onboarding, debugging, audits, and API docs are reading, not archaeology. (NestJS puts the graph behind a paid Devtools plan.)
- **One primitive for real-time.** Declare the transport — SSE, ndjson, or a WebSocket duplex — and return an `AsyncIterable`; backpressure and cleanup are handled. *Why it matters:* no separate gateway, adapter, or library to bolt on.
- **The same app runs on Node, Deno, Bun, and the edge.** One codebase, one import; you swap the entry point (`app.listen` → `serveDeno` / `serveBun` / `edgeHandler`) and nothing else. HTTP, SSE, and WebSocket — including rooms and channels — behave identically on all four. *Why it matters:* the graph model isn't a bet on one runtime's future, and no other opinionated/DI framework runs everywhere.
- **A remote dependency looks like a local one.** `@needs('billing')` resolves the same whether `billing` lives in this process or on another node (mesh, experimental). *Why it matters:* no gRPC layer or message-pattern DSL to learn — there's the graph, and some nodes happen to live elsewhere.
- **Plugins can't sabotage you.** A plugin gets `bus.on(...)` (observe) and `scope.add(...)` (extend its own scope). There is no API to reorder or delete another scope's steps. *Why it matters:* installing a plugin can't break your body parser.

## Real-time is a primitive, not a second framework

Most stacks treat "push data over time" as a bolt-on: Express reaches for a `ws` or SSE library, Fastify for a plugin, NestJS for a separate **WebSocket Gateway** with its own adapter and decorators. That's a second mental model, a second error surface, glued to your HTTP app.

green-tea has one model: an **`AsyncIterable`**. A handler that returns a sequence of values over time *is* a stream — the same shape you'd return from any function. You **declare the mode** with a decorator; the framework handles framing, backpressure, cleanup, and disconnects.

| Declare | Direction | Transport | Reach for it when |
|---|---|---|---|
| `@Sse` | server → client | `text/event-stream` | live updates to a browser (`EventSource`) |
| `@Ws` | duplex | WebSocket | chat, collaboration — anything two-way |
| `@Stream` | negotiated | SSE / ndjson / WS, picked from the client's `Accept` / `Upgrade` | one handler, the client chooses |

The primitive never changes — it's always an `AsyncIterable`. What changes is **direction and framing**, and you declare which. That's the difference between each iterable green-tea hands you:

- **`@Sse`** — you return **one** iterable: the *outbound* stream. Each `yield` becomes an SSE event, or an ndjson line.
- **`@Ws` (duplex)** — **two** iterables. `@inbound()` gives you the client's *incoming* messages to consume; the one you **return** is the *outbound* stream to the client. `@abort()` hands you an `AbortSignal` for teardown.
- **`@Stream`** — you write the handler once; the client's request decides whether it arrives as SSE, ndjson, or a WebSocket. No branching in your code.

**Your wire contract is what you declared, never what you happened to return.** A buffered route that returns an iterable, or a streaming route that returns a plain value, fails loudly with a `TransportMismatchError` — green-tea will not quietly switch a route's transport because of a return type. Refactoring a handler's internals can't change how it talks to the client.

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

## Batteries included — still one dependency

Beta shipped the parts a real API needs, without growing the runtime dependency tree past `reflect-metadata`:

- **TLS → https/wss** natively, plus proxy-aware `trustProxy` (`X-Forwarded-*` → `ctx.protocol`/`ctx.ip`).
- **Secure by default.** `nosniff`, `X-Frame-Options`, `Referrer-Policy`, HSTS-when-secure — on every response, opt-out with one flag.
- **CORS** with a guarded preflight and the credentials-never-`*` rule enforced for you.
- **Validation via [Standard Schema](https://standardschema.dev).** `@body(schema)` accepts zod, valibot, or arktype — you bring the validator, the core stays zero-dep. Invalid input → `422` with per-field issues; the parsed value reaches your handler typed.
- **Real body parsing.** JSON and urlencoded out of the box; `multipart/form-data` file uploads (`@body()` → `{ fields, files }`) via the optional [`busboy`](https://github.com/mscdex/busboy) peer dependency (`npm i busboy`) — a multipart request without it returns a clear `501`. All size-capped (`413`) against DoS.
- **Errors, your way.** Throw typed errors (`Unauthorized`, `NotFound`, `HttpError(status, msg, body?)`) anywhere; they convert centrally to `4xx`/`5xx`. Render them however you like — HTML, RFC 7807, content-negotiated — with a single `createApp({ onError })` hook that covers every error response.
- **HTML without a view layer.** `@Html` returns a string, serves a file, or renders one with the built-in `{{ }}` template engine — swap in EJS or handlebars with `createApp({ viewEngine })`. `createApp({ static: true })` serves `./public` with path-traversal guards and no mime dependency.
- **Graceful shutdown.** `app.close()` drains in-flight requests, closes live streams and mesh links.
- **Testable by construction.** `createApp({ overrides: { db: fakeDb } })` swaps any node in one line.
- **Dual ESM + CommonJS.** Ships both builds behind an `exports` map — `import` and `require` both resolve, with matching type declarations.

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
| **Real-time** | bolt on `ws`/`sse` libs | plugins | separate Gateway + adapter | separate engine | **return an `AsyncIterable`** — SSE, ndjson & WebSocket, one primitive |
| **Cross-service calls** | HTTP client / gRPC by hand | HTTP client / gRPC | Microservices transport + message patterns | — | **`@needs('x')` resolves on another node** |
| **Plugin can break your pipeline?** | yes (deletes your body parser) | encapsulated, but hooks are global | interceptor order matters | yes | **no** — plugins only `bus.on` + `scope.add` |
| **Runs on** | Node | Node | Node | Node | **Node · Deno · Bun · edge** — same code, swap the entry point |
| **Runtime deps** | minimal | minimal | heavy (rxjs, reflect-metadata, …) | Express + InversifyJS | **`reflect-metadata` only** (`ws`, `busboy` optional) |

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
| `@headers(...)` | request headers (whole bag or picked) | `()` · `('authorization')` · `(['a','b'])` · `(schema)` |
| `@header('name')` | one request header (singular alias of `@headers`) | `('x-trace')` · `('x-count', schema)` |

`@needs` keys are validated at boot: nothing provides the key → `createApp` throws with a clear error instead of serving `undefined`. Pass a Standard Schema (`@body(User)`) and the value is validated, coerced, and typed before your handler sees it.

> **Optional providers degrade, they don't crash.** A provider marked `optional: true` that throws on boot does **not** abort startup — it is left unregistered and logged. On `listen()` the app prints a one-line summary of what's running degraded, and the list is queryable via `app.degraded()`. Routes that actually need a degraded provider fail at request time, not at boot. This is deliberate (graceful degradation); wire an alert off `app.degraded()` or the `boot:provider:fail` bus event in production so a degraded start is never silent.

## Routing

Patterns match by segment: static, `:param` (one segment), and a trailing `:name*` **catch-all** that captures the rest of the path — slashes included — into `params.name`. When more than one route matches, the **most specific wins** (static ▸ `:param` ▸ catch-all), independent of registration order. A path that exists under a *different* method returns **`405` with an `Allow` header**, not `404`.

```typescript
@Get('/files/:path*')   //  /files/img/2026/logo.png  →  params.path = "img/2026/logo.png"
```

**Not yet** (post-beta, on the roadmap): regex / typed param constraints like `:id(\d+)`, and route matching is a linear scan — fine for typical route tables, but a radix-tree matcher for very large ones isn't built.

## Two layers

1. **Typed functional core (`flow`)** — `flow().step(...).step(...).handle(...)`; step outputs accumulate into the context type (`Acc & Out`). This is where the compile-time guarantee lives.
2. **Declarative decorator layer** — `@Provider/@Step/@Module/@Route/@Get/@Transformer` + argument decorators. Emits runtime metadata, builds and topologically sorts the graph, validates at boot.

## Why legacy decorators

green-tea uses **legacy** (experimental) decorators — you set `experimentalDecorators: true` in your `tsconfig`. This is a design decision, not inertia.

The framework's argument injection (`@param`, `@query`, `@body`, `@header`, `@needs`, `@ctx`, `@inbound`, `@abort`) relies on **parameter decorators** — and the TC39 standard decorators proposal (Stage 3) deliberately does **not** include them. There is no standards-track way to decorate a parameter today, so a handler like `handler(@param('id') id: string)` is only expressible with legacy decorators.

"Stage 3" also means *not finalized*: the proposal can still change before engines ship it. We track it, and if parameter injection ever gets a viable standard path we'll revisit. Until then, legacy decorators are the right tool for this API — not a shortcut. (We don't rely on `emitDecoratorMetadata`/`design:type` reflection; argument positions are recorded explicitly, so this is the only legacy surface we depend on.)

## Honest scope

green-tea is **beta**, on the road to a release candidate. Express and Fastify have a decade of ecosystem; NestJS has enterprise tooling and a huge plugin catalog. Pick green-tea for the model and the ergonomics, not the ecosystem — *yet*.

**Bring your own auth (and friends).** green-tea ships transport security — TLS/wss, secure-by-default headers, CORS — but **not** authentication, authorization, rate-limiting, CSRF, or sessions. You compose those as steps and plugins (the `Authenticate` step in the quick look is the pattern). Unlike Express/Fastify, there is no off-the-shelf plugin ecosystem for them yet.

**Runtimes differ in what they can offer.** Node ≥ 18, Deno, and Bun run everything. On the edge (Cloudflare Workers) there is no `app.listen()`, no filesystem — so `@Html` file/template modes and `static` serving are unavailable — and mesh does not run there at all (the teapot's secret comparison needs `node:crypto`'s `timingSafeEqual`, which `nodejs_compat` doesn't provide). Workers also require the `nodejs_compat` flag.

**mesh is alpha.** Distributed DI works, but discovery, load-balancing, and failover are not built, and its API and wire protocol may change between releases. It is gated behind an explicit opt-in — `createApp({ mesh, experimental: true })` — and `createApp` throws if you configure `mesh` without it. Don't ship mesh to production yet.

## Docs & development

- **[green-tea.expressive-tea.io/docs](https://green-tea.expressive-tea.io/docs)** — getting started, concepts (the graph, `flow`), and guides: routing, DI, validation, uploads, streaming, HTML, security, errors, introspection, OpenAPI, plugins, mesh, runtimes, testing.
- **[matcha](https://github.com/Expressive-Tea/matcha)** — the CLI. `matcha new` scaffolds a project (Node, Deno, or Bun), `matcha create` generates and auto-wires controllers/steps/providers/modules, `matcha run` detects your runtime and watches. A standalone Rust binary — no JS runtime needed to install it.

```bash
npm install
npm test           # vitest (Node); test:deno / test:bun / test:edge for the other runtimes
npm run typecheck  # tsc --noEmit (includes the compile-time-guarantee type test)
npm run build      # emit dist/ (tsup: dual ESM + CJS)
npm run bench      # regenerate BENCHMARKS.md
npm run docs:dev   # the documentation site (website/)
```

## Roadmap

- ✅ **transport security** — native TLS/wss, CORS, secure-by-default headers, `trustProxy`.
- ✅ **request I/O** — JSON / urlencoded / multipart uploads, size limits, graceful shutdown, Standard Schema validation.
- ✅ **streams** — SSE / ndjson / WebSocket duplex over a multicast `AsyncIterable` channel, with backpressure and cleanup.
- ✅ **graph introspection** — `explain` / `graph` / `toMermaid` / `GET /__graph__`.
- ✅ **mesh (walking skeleton)** — `teapot`/`teacup` distributed DI over a secret-gated WS control channel. A BEAM/OTP-style cluster, *not* microservices.
- ✅ **runs everywhere** — Node, Deno, Bun, and Cloudflare Workers over web-standard `Request`/`Response`, with identical WebSocket behaviour on all four.
- ✅ **HTML** — `@Html` (string / file / template), a built-in template engine with a bring-your-own `viewEngine` hook, and `static` serving.
- **next** — API freeze + first published release, mesh sub-specs (discovery, load-balancing, failover), official plugins, router regex constraints and a radix-tree matcher.

## Versioning

green-tea uses **calendar versioning**: `YY.M.PATCH` (e.g. `26.7.0` = the first release cut in July 2026, patch 0). The month is **not** zero-padded — npm treats versions as semver, which forbids leading zeros. A version tells you *when* it shipped, not how many breaking changes preceded it — those are always called out in the [CHANGELOG](./CHANGELOG.md).

**While in beta**, releases carry a `-beta.N` pre-release suffix on the calendar version (e.g. `26.7.0-beta.0`) and publish under the npm `beta` dist-tag — so a plain `npm install @green-tea/core` won't pick one up until the first stable calendar release. The API can still change between betas.

## License

[MIT](./LICENSE) © green-tea contributors. Contributions require a [DCO sign-off](./CONTRIBUTING.md).
