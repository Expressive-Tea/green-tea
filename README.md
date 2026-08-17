<p align="center">
  <img src="./assets/logo.png" width="112" alt="Green Tea" />
</p>

<h1 align="center">Green&nbsp;Tea.</h1>

<p align="center"><b>A zen, opinionated, type-safe framework.</b></p>

<p align="center">
  Your API is an explicit <b>dependency graph</b> you can see, slice, and trust —<br />
  not a mutable bag threaded through positional middleware. <i>That's the tea.</i> 🍵
</p>

---

## The problem

```js
const user = req.user;
```

It compiles. TypeScript is happy. And it's a prayer — `req.user` exists only if some middleware ran before this handler, which depends on where the router got mounted, which line `app.use()` sits on, and whether a package you installed last sprint quietly inserted itself into the middle of your chain.

So you keep the whole request in your head: what ran, what's on `req` by now, what order things fire in, which plugin deleted your body parser. That bookkeeping is where the bugs live, and no test or type catches them, because nothing is *wrong* — the code is correct and the app is still broken.

## The idea

green-tea puts the request on the page instead. You declare what each step **needs** and **produces**; the framework computes the order, type-checks the wiring, and can print the whole thing.

- Order is **derived** from your dependencies, never maintained by hand.
- Boot **fails loudly** when nothing provides a key, so you never serve `undefined`.
- A route runs **only** the steps its handler actually depends on.
- `app.explain('/users/:id')` prints the whole chain. Onboarding is reading, not archaeology.

Less to hold in your head. That's the tea.

```bash
npm install @green-tea/core@beta reflect-metadata
```

`@green-tea/core` — **beta**, RC-track. One runtime dependency: `reflect-metadata`. Two optional peers you install only if you use them:

```bash
npm install ws       # WebSocket routes (@Ws) and mesh
npm install busboy   # multipart/form-data file uploads
```

## What's different — and why it matters

- **The pipeline is a graph, not a chain.** You never write "put this before that." You declare `needs`/`provides` and green-tea topologically sorts it. *Why it matters:* no ordering bugs, no positional guesswork, and each route runs only its slice of the graph (an auth step doesn't run on public routes).
- **The type is the contract.** What a handler reads from the context *is* its dependency list. In the typed `flow` core, a handler that reads `ctx.user` **fails to compile** if no step produces `user`. *Why it matters:* whole classes of "it was undefined in prod" disappear at compile time.
- **You can see the request before it runs.** `app.explain('/users/:id')` prints the ordered chain with origins; `app.graph()` / `GET /__graph__` render it as a live diagram; `app.openapi()` projects the same metadata into an OpenAPI 3.1 spec. *Why it matters:* onboarding, debugging, audits, and API docs are reading, not archaeology. (NestJS puts the graph behind a paid Devtools plan.)
- **One primitive for real-time.** Declare the transport — SSE, ndjson, or a WebSocket duplex — and return an `AsyncIterable`; backpressure and cleanup are handled. *Why it matters:* no separate gateway, adapter, or library to bolt on.
- **The same app runs on Node, Deno, Bun, and the edge.** One codebase, one import; you swap the entry point (`app.listen` → `serveDeno` / `serveBun` / `edgeHandler`) and nothing else. HTTP, SSE, and WebSocket — including rooms and channels — behave identically on all four. *Why it matters:* the graph model isn't a bet on one runtime's future, and no other opinionated/DI framework runs everywhere.
- **A remote dependency looks like a local one.** `@needs('billing')` resolves the same whether `billing` lives in this process or on another node (mesh, experimental). *Why it matters:* no gRPC layer or message-pattern DSL to learn — there's the graph, and some nodes happen to live elsewhere.
- **Plugins can't sabotage you.** A plugin gets `bus.on(...)` (observe), `scope.add(...)` (extend its own scope) and `onShutdown(...)` (release what it opened). There is no API to reorder or delete another scope's steps. *Why it matters:* installing a plugin can't break your body parser.

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
- **Ceilings that are already on.** `limits` caps body size (`413`), multipart parts, concurrent Node connections (default `1000`; `<= 0` leaves connections unlimited), and the request / headers / keep-alive timeouts — defaulting to `30s` / `10s` / `5s`, tighter than Node's own two-minute default. When Node's connection cap is reached, excess sockets are destroyed without an HTTP response. Deno and Bun expose no equivalent active-socket cap, so enforce one at the deployment platform or reverse proxy there. Configurable, and safe before you configure anything.
- **Observability without an integration.** Every request carries an id and a trace id through every lifecycle event, each step reports its own duration, and `createApp({ logger })` accepts any logger — the default writes structured JSON. Nothing in core writes to `console`. Metrics and tracing exporters read the same stream from outside core.
- **Graceful shutdown, with a deadline.** `app.close()` drains in-flight requests and closes live streams and mesh links, then warns and force-closes whatever is still open after 10 seconds — so a stuck handler cannot hold a deploy open forever. Change the number per call with `close({ timeoutMs })` or for the whole app with `createApp({ shutdownTimeoutMs })`. Connection *draining* is Node-only; on Deno and Bun the server `serveDeno()`/`serveBun()` returns carries the same `close({ timeoutMs })`.
- **Shutdown is an extension point, not a `SIGTERM` handler you write.** A provider that opened a pool closes it in `dispose()`; a plugin registers `onShutdown(...)`; an application that wants neither passes `createApp({ hooks: [{ onShutdown }] })`. All three land in one registry, run in reverse boot order — a `cache` that needs `db` closes first — and are *awaited*, unlike a `bus.on` listener. A failure is logged and the rest still run, because one broken teardown must not leave the process up. Everything happens inside `close()`'s deadline; `createApp({ teardownTimeoutMs })` reserves a slice of it when a connection must get its chance. *Not available on the edge* — workerd has no shutdown to hook.
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

> **Optional providers degrade, they don't crash.** A provider marked `optional: true` that throws on boot does **not** abort startup — it is left unregistered and logged. The first serving call (`fetch`, `upgrade`, or `listen`) prints a one-line summary of what's running degraded, and the list is queryable via `app.degraded()`. Routes that actually need a degraded provider fail at request time, not at boot. This is deliberate (graceful degradation); wire an alert off `app.degraded()` or the `boot:provider:fail` bus event in production so a degraded start is never silent.

## Routing

Patterns match by segment: static, constrained params such as `:id(\d+)`, plain `:param`, and a trailing `:name*` **catch-all**. The most specific wins (static ▸ constrained ▸ plain param ▸ catch-all), and ambiguous same-method shapes fail at boot instead of depending on registration order.

```typescript
@Get('/users/:id(\\d+)') // /users/42
@Get('/files/:path*')   //  /files/img/2026/logo.png  →  params.path = "img/2026/logo.png"
```

`@Head` and `@Options` provide explicit handlers. Otherwise a buffered GET can serve HEAD without a body, and OPTIONS on an existing path returns `204` with canonical `Allow`; other method mismatches return `405`. `/path` and `/path/` are equivalent, while repeated slashes and malformed encoding return `400` rather than being normalized ambiguously. Constraints use a deliberately safe regex subset. See the full [routing guide](https://green-tea.expressive-tea.io/docs/guides/routing/).

Matching is still a linear scan — fine for typical route tables. A radix tree for very large tables remains post-beta work.

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

**Observability is a contract, not an integration.** Core emits a correlated lifecycle event stream — every request gets an id (an incoming `x-request-id` is adopted, not replaced), every event carries it, and each step reports its own duration. `createApp({ logger })` takes any logger; the default writes structured JSON, or a readable line on a TTY. Nothing in core writes to `console`, which is enforced by a lint rule rather than a promise. `createApp({ logRequests: true })` logs a line per request, off by default.

**What is not here:** no metrics registry, and **no OpenTelemetry exporter in core** — that is a separate package, because core has one runtime dependency and intends to keep it. A `traceparent` header is carried through untouched for an exporter to interpret; core implements no propagation spec. If your definition of production-ready includes shipping traces on day one, you are writing the exporter, and the stream it needs is the part that now exists.

**Runtimes differ in what they can offer.** Node ≥ 18, Deno, and Bun run everything. On the edge (Cloudflare Workers) there is no `app.listen()`, no filesystem — so `@Html` file/template modes and `static` serving are unavailable — and mesh does not run there at all (the teapot's secret comparison needs `node:crypto`'s `timingSafeEqual`, which `nodejs_compat` doesn't provide). Workers also require the `nodejs_compat` flag.

**mesh is alpha.** Distributed DI works, but discovery, load-balancing, and failover are not built, and its API and wire protocol may change between releases. It is gated behind an explicit opt-in — `createApp({ mesh, experimental: true })` — and `createApp` throws if you configure `mesh` without it. Don't ship mesh to production yet.

**What is settled, and what is still moving.** Present state, not a roadmap and not the API freeze — this is spare-time work by one person, and a schedule it cannot keep would cost more than it earns. The **graph is the settled part**: `needs`/`provides`, the order derived from them, and the boot-time failure when nothing provides a key have not changed since the beta hardening on 7 July, and `@Provider`, `@Step`, `@Route` and handler shapes still mean what they meant then — the decorator *set* has grown (`@Head`, `@Options`, `@Html`), which only ever adds. **Still moving:** the plugin API, which gained `onShutdown` this week; `createApp`'s options, which gain fields most months; and the pipeline context, which in July became one object mutated in place rather than copied per step — so a step that captured it now sees later steps' writes. **Alpha:** mesh, above. Legacy decorators are a standing *external* risk rather than a green-tea one — see [Why legacy decorators](#why-legacy-decorators). The [matcha](https://github.com/Expressive-Tea/matcha) CLI ships from its own repository on its own version line, so nothing here speaks for it.

## Docs & development

- **[green-tea.expressive-tea.io/docs](https://green-tea.expressive-tea.io/docs)** — getting started, concepts (the graph, `flow`), and guides: routing, DI, validation, uploads, streaming, HTML, security, errors, introspection, OpenAPI, plugins, mesh, runtimes, testing. Its source lives in [green-tea-docs](https://github.com/Expressive-Tea/green-tea-docs).
- **[matcha](https://github.com/Expressive-Tea/matcha)** — the CLI. `matcha new` scaffolds a project (Node, Deno, or Bun), `matcha create` generates and auto-wires controllers/steps/providers/modules, `matcha run` detects your runtime and watches. A standalone Rust binary — no JS runtime needed to install it.

> **Changing public API? The docs are a separate repository now, and nothing tells you when you break them.**
> [green-tea-docs](https://github.com/Expressive-Tea/green-tea-docs) imports nothing from here, so no build fails and no test turns red when a guide describes an API that no longer exists. **A pull request that changes public API updates the page documenting it, in the same pull request.** This is a rule rather than a check because no check exists yet — issue #18 is what a stale page looks like from a user's side, and that happened while both still lived in this repository.

```bash
npm install
npm test           # vitest (Node only) — the fast loop, ~2s
npm run test:all   # everything below, plus the JSR gate — the pre-push check
npm run test:deno  # deno test    } a change to shared code can pass `npm test`
npm run test:bun   # bun test     } and still be broken on one of these
npm run test:edge  # workerd via miniflare
npm run typecheck  # tsc --noEmit (includes the compile-time-guarantee type test)
npm run build      # emit dist/ (tsup: dual ESM + CJS)
npm run bench      # regenerate BENCHMARKS.md
```

`npm test` stays Node-only on purpose: it is the loop you run constantly, and booting Deno, Bun and
workerd into it would tax every run to catch what CI already catches on every push. Nothing here is
unguarded — the `runtimes` job runs all three, and `deno publish --dry-run` gates JSR. `test:all` is
for the moment before you push, when you would rather find out locally.

That last one is a second type-checker, not a packaging formality: `npm run typecheck` is `tsc` with
this repository's config, while `deno publish --dry-run` is Deno's checker with Deno's lib plus JSR's
slow-types rules over the public API. JSR serves `src/` directly, so what it rejects is what a JSR
consumer would have received.

## Roadmap

- ✅ **transport security** — native TLS/wss, CORS, secure-by-default headers, `trustProxy`.
- ✅ **request I/O** — JSON / urlencoded / multipart uploads, size limits, graceful shutdown, Standard Schema validation.
- ✅ **streams** — SSE / ndjson / WebSocket duplex over a multicast `AsyncIterable` channel, with backpressure and cleanup.
- ✅ **graph introspection** — `explain` / `graph` / `toMermaid` / `GET /__graph__`.
- ✅ **mesh (walking skeleton)** — `teapot`/`teacup` distributed DI over a secret-gated WS control channel. A BEAM/OTP-style cluster, *not* microservices.
- ✅ **runs everywhere** — Node, Deno, Bun, and Cloudflare Workers over web-standard `Request`/`Response`, with identical WebSocket behaviour on all four. Every CI run exercises all four; the Deno, Bun, and workerd suites gate a merge exactly as the Node one does.
- ✅ **HTML** — `@Html` (string / file / template), a built-in template engine with a bring-your-own `viewEngine` hook, and `static` serving.
- ✅ **router completeness for beta** — safe constrained params, deterministic precedence, explicit/automatic HEAD and OPTIONS, strict path validation, and ambiguity checks across local and mesh routes.
- ✅ **observability** — a correlated lifecycle event stream (request id, trace id, route pattern, per-step timings) and an injectable `Logger`. Exporters live outside core.
- **next** — API freeze + first published release, mesh sub-specs (discovery, load-balancing, failover), official plugins, and a radix-tree matcher for very large route tables.

## Versioning

green-tea uses **calendar versioning**: `YY.M.PATCH` (e.g. `26.8.0` = the first release cut in August 2026, patch 0). The month is **not** zero-padded — npm treats versions as semver, which forbids leading zeros. A version tells you *when* it shipped, not how many breaking changes preceded it — those are always called out in the [CHANGELOG](./CHANGELOG.md).

**While in beta**, releases carry a `-beta.N` pre-release suffix on the calendar version (e.g. `26.8.0-beta.0`) and publish under the npm `beta` dist-tag. Until the first stable release there is nothing else to install, so `latest` tracks the newest beta too — `npm install @green-tea/core` and `@green-tea/core@beta` resolve to the same version. Install with the explicit `@beta` tag anyway: the day a stable ships, `latest` moves to it and your installs stay on the channel you meant. The API can still change between betas.

## License

[MIT](./LICENSE) © green-tea contributors. Contributions require a [DCO sign-off](./CONTRIBUTING.md).
