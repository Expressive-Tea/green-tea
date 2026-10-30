<p align="center">
  <img src="./assets/logo.png" width="112" alt="Green Tea" />
</p>

<h1 align="center">Green&nbsp;Tea.</h1>

<p align="center"><b>A zen, opinionated, type-safe framework.</b></p>

<p align="center">
  <b>Declare intent. Derive execution.</b><br />
  You declare what each step <b>needs</b> and <b>produces</b>; green-tea derives the order,<br />
  validates the wiring before it serves traffic, and runs only the slice each route requires.
</p>

<p align="center">
  <i>Less infrastructure in your application. Less infrastructure in your head.</i> 🍵
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

Requires Node 22 or newer. Node 18 and 20 are end-of-life and are not supported. Deno, Bun and Cloudflare Workers run the same code.

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
- **The same app runs on Node, Deno, Bun, and the edge.** One codebase, one import; you swap the entry point (`await app.listen()` → `await serveDeno()` / `await serveBun()` / `edgeHandler`) and nothing else — each one boots the app before it binds, so a provider that cannot start fails the deploy instead of answering `500`s from a port that looks healthy. HTTP, SSE, and WebSocket — including rooms and channels — behave identically on all four. *Why it matters:* the graph model isn't a bet on one runtime's future, and no other opinionated/DI framework runs everywhere.
- **A remote dependency looks like a local one.** `@needs('billing')` resolves the same whether `billing` lives in this process or on another node (mesh, experimental). *Why it matters:* no gRPC layer or message-pattern DSL to learn — there's the graph, and some nodes happen to live elsewhere.
- **Plugins can't sabotage you.** A plugin is `{ name, mount(api) }`. It gets `bus.on(...)` (observe), `scope.add(...)` (extend its own scope) and `onShutdown(...)` (release what it opened). There is no API to reorder or delete another scope's steps. *Why it matters:* installing a plugin can't break your body parser.

## Who does the work?

Every backend has the same set of infrastructure decisions. The question is which side of the
`import` they live on.

| Decision | Owned by |
|---|---|
| Execution order | green-tea — derived from `needs`/`provides`, never maintained by hand |
| Dependency validation | green-tea — boot fails when nothing provides a key |
| Which steps a route runs | green-tea — the graph slice its handler actually depends on |
| Streaming mechanics — framing, backpressure, cleanup, disconnects | green-tea |
| OpenAPI projection | green-tea — from the same metadata that runs the app |
| Secure transport defaults | green-tea — headers, CORS, TLS |
| Runtime serving boundary | green-tea — `listen`, `fetch`, `upgrade` per runtime |
| Shutdown sequencing | green-tea — drain, then teardown, inside one deadline |
| **Business rules** | **you** |

That division is the whole design, and it is why `reflect-metadata` is the only runtime dependency:
the goal is not a small number for its own sake, it is **fewer moving parts your team has to
understand, upgrade, coordinate and debug**. A framework that owns less pushes the difference into
your application, where it becomes your maintenance instead of disappearing.

Automated does not mean invisible. `app.explain()` prints the ordered chain, `app.graph()` renders
the live graph, and `app.openapi()` projects the same metadata — the graph is not documentation drawn
after the fact, it is the structure green-tea validates and executes.

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

## What the foundation already carries

The parts a real API needs, owned by the framework rather than assembled in your application — and
without growing the runtime dependency tree past `reflect-metadata`:

- **TLS → https/wss** natively, plus proxy-aware `trustProxy` (`X-Forwarded-*` → `ctx.protocol`/`ctx.ip`).
- **Secure by default.** `nosniff`, `X-Frame-Options`, `Referrer-Policy`, HSTS-when-secure — on every response, opt-out with one flag.
- **CORS** with a guarded preflight and the credentials-never-`*` rule enforced for you.
- **Validation via [Standard Schema](https://standardschema.dev).** `@body(schema)` accepts zod, valibot, or arktype — you bring the validator, the core stays zero-dep. Invalid input → `422` with per-field issues; the parsed value reaches your handler typed.
- **Real body parsing.** JSON and urlencoded out of the box; `multipart/form-data` file uploads (`@body()` → `{ fields, files }`) via the optional [`busboy`](https://github.com/mscdex/busboy) peer dependency (`npm i busboy`) — a multipart request without it returns a clear `501`. All size-capped (`413`) against DoS.
- **Errors, your way.** Throw typed errors (`Unauthorized`, `NotFound`, `HttpError(status, msg, body?)`) anywhere; they convert centrally to `4xx`/`5xx`. Render them however you like — HTML, RFC 7807, content-negotiated — with a single `createApp({ onError })` hook that covers every error response.
- **HTML without a view layer.** `@Html` returns a string, serves a file, or renders one with the built-in `{{ }}` template engine — swap in EJS or handlebars with `createApp({ viewEngine })`. `createApp({ static: true })` serves `./public` with path-traversal guards and no mime dependency. Static files carry a weak `ETag`, `Last-Modified` and `Cache-Control: no-cache` (change it with `static: { dir, cacheControl }`), and a conditional request gets a `304` without the file being read. `createApp({ etag: true })` does the same for buffered `GET`/`HEAD` handler responses, and `createApp({ compression: true })` compresses text responses and event streams with gzip or br. It uses `node:zlib` on Node, Deno and Bun, and leaves encoding to the platform on the edge.
- **Resource ceilings, with safe defaults.** `limits` caps body size (`413`), multipart parts, concurrent Node connections (default `1000`; `<= 0` leaves connections unlimited), and the request / headers / keep-alive timeouts — defaulting to `30s` / `10s` / `5s`, tighter than Node's own two-minute default. `maxConcurrentRequests` is opt-in and applies per server or Fetch adapter instance; when set, excess in-flight requests receive `503` and `Retry-After: 1`. It bounds concurrently executing handlers, so a handler that never returns continues to hold its slot; on Node, a client disconnect releases that slot. Long-lived streams and WebSocket upgrades do not hold that request budget. When Node's connection cap is reached, excess sockets are destroyed without an HTTP response. Deno and Bun expose no equivalent active-socket cap, so enforce one at the deployment platform or reverse proxy there. WebSocket connections are bounded too: `maxWsMessageBytes` (default 1 MiB) closes a connection whose message is larger with `1009`, and `maxWsQueue` (default `16`) closes one that has that many unread inbound messages and receives another with `1013`, rather than dropping anything. Both are server-wide and must be positive integers. Node and Bun refuse an oversized message before buffering it (Bun before 1.4 drops the connection, so its peer sees `1006`; Bun 1.4 and later send `1009`); Deno and the edge check it after the runtime has received it. Worst case, a server buffers about `maxConnections × maxWsQueue × maxWsMessageBytes` of inbound messages — ≈ 15.6 GiB at the Node defaults.
- **Observability without an integration.** Every request carries an id and a trace id through every lifecycle event, each step reports its own duration, and `createApp({ logger })` accepts any logger — the default writes structured JSON. Nothing in core writes to `console`. Metrics and tracing exporters read the same stream from outside core.
- **Graceful shutdown, with a deadline.** `app.close()` drains in-flight requests and closes live streams and mesh links, then warns and force-closes whatever is still open after 10 seconds — so a stuck handler cannot hold a deploy open forever. Change the number per call with `close({ timeoutMs })` or for the whole app with `createApp({ shutdownTimeoutMs })`. Connection *draining* is Node-only; on Deno and Bun the server `serveDeno()`/`serveBun()` returns carries the same `close({ timeoutMs })`.
- **Liveness and readiness probes.** `createApp({ health: true })` serves `/__live__` and `/__ready__`. Readiness reports `booting`, `ok`, `degraded` (optional providers that failed) or `draining` (from the moment `close()` starts). Probes are answered ahead of the pipeline: they are never shed and never show up in lifecycle events or request logs. `health: { drainDelayMs }` keeps the listener open for that window after `close()` starts, so a load balancer reads the `503` before connections drain. The edge never reports `draining`, because it has no `close()`.
- **Shutdown is an extension point.** A provider that opened a pool closes it in `dispose()`; a plugin registers `onShutdown(...)`; an application that wants neither passes `createApp({ hooks: [{ onShutdown }] })`. All three land in one registry, run in reverse boot order — a `cache` that needs `db` closes first — and are *awaited*, unlike a `bus.on` listener. A failure is logged and the rest still run, because one broken teardown must not leave the process up. Everything happens inside `close()`'s deadline; `createApp({ teardownTimeoutMs })` reserves a slice of it when a connection must get its chance. *Not available on the edge* — workerd has no shutdown to hook.
- **The `SIGTERM` handler is yours to keep or to hand over.** All of the above runs from `close()`, and something has to call it — a container `SIGKILL`ed after its grace period skips every `dispose()` and reports nothing. Write the handler yourself and keep the control, or set `createApp({ handleSignals: true })` and the framework registers `SIGINT`/`SIGTERM` to close and exit for you. Off by default, because a library that installs process-wide handlers behind your back is worse than one that installs none. Turning it on also absorbs the last runtime difference an app has: `process.on` on Node and Bun, `Deno.addSignalListener` on Deno, and the matching `exit` for each — `listen()`, `serveDeno()` and `serveBun()` each wire it to the closer that drains *their* server. `close()` unregisters, so a second Ctrl-C ends a teardown that is stuck.
- **Testable by construction.** `createApp({ overrides: { db: fakeDb } })` swaps any node in one line.
- **Dual ESM + CommonJS.** Ships both builds behind an `exports` map — `import` and `require` both resolve, with matching type declarations.

## Benchmarks

green-tea keeps a reproducible [autocannon](https://github.com/mcollina/autocannon) harness in
`bench/`, and it is written to be hard on green-tea rather than flattering. It answers two
different questions, and they need different setups:

- **How does green-tea compare to other frameworks?** `npm run bench` runs green-tea, Express 5,
  Fastify 5, NestJS on Express and on Fastify, and raw Node `http` through the same scenarios on
  one box, then writes [BENCHMARKS.md](./BENCHMARKS.md).
- **Did the last N commits cost anything?** `npm run bench:compare` runs two versions of green-tea
  on one box in one sitting, alternating sides, so the difference is the code rather than the
  machine's mood that day.

This section carries no numbers on purpose. A ranking written into prose is a claim nobody
re-measures, and it goes stale with the next release. The figures, the hardware and date they
were taken on, and the caveats live in [BENCHMARKS.md](./BENCHMARKS.md). The caveats include
single-box loopback, trusting the ratios over the absolute numbers, and green-tea running with
`security: false` for header parity, with the cost of secure-by-default measured separately.

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
| `@cookies(...)` | request cookies, parsed from `Cookie` (whole map or picked) | `()` · `('sid')` · `(['a','b'])` · `(schema)` |
| `@cookie('name')` | one request cookie (singular alias of `@cookies`) | `('sid')` · `('sid', schema)` |

To send cookies, `setCookie(name, value, options?)` returns a `Set-Cookie` value with safe defaults (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure`) and throws on anything that could inject a header. Response header values are `string | string[]`: a `set-cookie` array is sent as one line per cookie on every runtime, any other array as one line joined with `, `. Pass `secure: false` where the browser will not keep a `Secure` cookie over plain HTTP (Safari, a LAN IP). Signing and sessions are not in core.

`@needs` keys are validated at boot: nothing provides the key → `createApp` throws with a clear error instead of serving `undefined`. Pass a Standard Schema (`@body(User)`) and the value is validated, coerced, and typed before your handler sees it.

> **Optional providers degrade, they don't crash.** A provider marked `optional: true` that throws on boot does **not** abort startup — it is left unregistered and logged. The first serving call (`fetch`, `upgrade`, or `listen`) prints a one-line summary of what's running degraded, and the list is queryable via `app.degraded()`. Routes that actually need a degraded provider fail at request time, not at boot. This is deliberate (graceful degradation); wire an alert off `app.degraded()` or the `boot:provider:fail` bus event in production so a degraded start is never silent.

## Routing

Patterns match by segment: static, constrained params such as `:id(\d+)`, plain `:param`, and a trailing `:name*` **catch-all**. The most specific wins (static ▸ constrained ▸ plain param ▸ catch-all), and ambiguous same-method shapes fail at boot instead of depending on registration order.

```typescript
@Get('/users/:id(\\d+)') // /users/42
@Get('/files/:path*')   //  /files/img/2026/logo.png  →  params.path = "img/2026/logo.png"
```

`@Head` and `@Options` provide explicit handlers. Otherwise a buffered GET can serve HEAD without a body, and OPTIONS on an existing path returns `204` with canonical `Allow`; other method mismatches return `405`. `/path` and `/path/` are equivalent, while repeated slashes and malformed encoding return `400` rather than being normalized ambiguously. Constraints use a deliberately safe regex subset. See the full [routing guide](https://green-tea.expressive-tea.io/docs/guides/routing/).

Because that subset is linear, constraints are also compared at boot. Two routes that branch at the same segment, under the same prefix and method, fail `createApp`:

- **ambiguous**: two constrained params accept a common segment and the rest of both patterns can match one request. The error names both routes and a segment both accept, such as `/u/:id(\d+)` + `/u/:n(\d{1,3})`, which both match `'0'`. Different spellings of one language (`\d+`, `[0-9]+`) count.
- **unreachable**: a plain `:param` whose constrained sibling accepts every segment, such as `[^]*`, and wins every request the plain one could take.

A constraint next to a plain param is still the fallback pattern: with `/u/:id(\d+)` + `/u/:slug`, digits go to `:id` and everything else goes to `:slug`. An unescaped `.` does not match a line terminator, so `(.*)` does not cover every segment. WebSocket routes follow the same rules, except that they match in declaration order, so a plain WS param declared before a constrained one makes the constrained one unreachable. Mesh routes exported by different teapots are checked against each other; a local route still overrides a remote one, with a warning.

Lookup uses a radix tree per method, built once from the final route table, so a request only walks the branches its path can follow. Precedence is the same as above, and so are `Allow`, 405 and OPTIONS.

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

**Runtimes differ in what they can offer.** Node ≥ 22, Deno, and Bun run everything. On the edge (Cloudflare Workers) there is no `app.listen()`, no filesystem — so `@Html` file/template modes and `static` serving are unavailable — and mesh does not run there at all (the teapot's secret comparison needs `node:crypto`'s `timingSafeEqual`, which `nodejs_compat` doesn't provide). Workers also require the `nodejs_compat` flag. Native TLS (`createApp({ tls })`) is Node's `listen()` only: `serveDeno()` and `serveBun()` reject an app that sets it rather than serve it as plain HTTP, so configure TLS on that runtime's server or at a proxy, as you would on the edge. With `compression`, core never encodes on the edge (Cloudflare does), and on Deno it runs zlib on the main thread, where Deno's own `automaticCompression` is the faster gzip.

**mesh is alpha.** Distributed DI works, but discovery, load-balancing, and failover are not built, and its API and wire protocol may change between releases. It is gated behind an explicit opt-in — `createApp({ mesh, experimental: true })` — and `createApp` throws if you configure `mesh` without it. Don't ship mesh to production yet.

**What a teapot exports: steps and routes, and nothing else.** A `@Provider` marked `export: true` fails the boot with an error that says why — a provider's value *is* the object it builds, a pool or a client or a `db`, and the mesh moves data, not objects. Export a `@Step` instead: it runs on the teapot, per request, and its result is what comes back. That is also what lets a teacup boot without its teapot: a remote step holds nothing between requests, so a teacup whose teapot never answers still starts once the `bootTimeoutMs` grace runs out — it warns and carries on. Be precise about what that means, because it is narrower than it sounds. A teapot that never connected sent no manifest, so nothing of it reached the graph: its routes **404** rather than `503`, since nothing was registered to match, and a local step that `@needs` one of its tokens **still fails the boot**, naming the teapot that did not connect. That failure is deliberate — it is the check that catches a typo in a token name, which no amount of waiting will fix. `503` is what you get from a teapot that connected and *later* died, where the link and its exports do exist. So what the change buys is the teacup that does *not* depend on that teapot starting anyway, rather than refusing over a dependency it never had. Keeping a *needed* token serving while its teapot is legitimately away is a known gap, not an oversight: the intended answer is a per-teapot `expects` list that declares what a teapot would export, which is planned and not built.

**What is settled, and what is frozen.** From RC.1 the public surface of the four entry points (`@green-tea/core`, `/deno`, `/bun`, `/edge`) is frozen. Between RC.1 and the first stable release, releases are fixes only: nothing is added, removed, renamed or narrowed. Nothing published in `26.9.0-beta.2` was removed to reach the freeze. [API stability](#api-stability) has the full policy. That covers the graph (`needs`/`provides`, the order derived from them, and the boot-time failure when nothing provides a key), the decorators and handler shapes, the plugin API (`{ name, mount }` with `onShutdown`), the runtime entry points (`serveDeno()` and `serveBun()` are async so they boot before they bind), `createApp`'s options, and the pipeline context, which is one object mutated in place, so a step sees what earlier steps wrote. **Outside the freeze:** mesh, marked `@experimental` and described above. Legacy decorators are a standing *external* risk rather than a green-tea one — see [Why legacy decorators](#why-legacy-decorators). The [matcha](https://github.com/Expressive-Tea/matcha) CLI ships from its own repository on its own version line, so nothing here speaks for it.

## Docs & development

- **[green-tea.expressive-tea.io/docs](https://green-tea.expressive-tea.io/docs)** — getting started, concepts (the graph, `flow`), and guides: routing, DI, validation, uploads, streaming, HTML, security, errors, introspection, OpenAPI, plugins, mesh, runtimes, testing. Its source lives in [green-tea-docs](https://github.com/Expressive-Tea/green-tea-docs).
- **For LLM coding agents:** [`llms.txt`](./llms.txt) ships in the package (`node_modules/@green-tea/core/llms.txt`) and matches the installed version; the docs serve the whole site as one file at [`/docs/llms-full.txt`](https://green-tea.expressive-tea.io/docs/llms-full.txt).
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
- ✅ **radix-tree matcher** — route lookup by index rather than a walk past every candidate, so a 200-route table costs about what a 10-route one does.
- **next** — first stable release, mesh sub-specs (discovery, load-balancing, failover), and official plugins.

## Versioning

green-tea uses **calendar versioning**: `YY.M.PATCH` (e.g. `26.8.0` = the first release cut in August 2026, patch 0). The month is **not** zero-padded — npm treats versions as semver, which forbids leading zeros. A version tells you *when* it shipped, not how many breaking changes preceded it — those are always called out in the [CHANGELOG](./CHANGELOG.md).

**While in beta**, releases carry a `-beta.N` pre-release suffix on the calendar version (e.g. `26.8.0-beta.0`) and publish under the npm `beta` dist-tag. Until the first stable release there is nothing else to install, so `latest` tracks the newest beta too — `npm install @green-tea/core` and `@green-tea/core@beta` resolve to the same version. Install with the explicit `@beta` tag anyway: the day a stable ships, `latest` moves to it and your installs stay on the channel you meant. Release candidates (`-rc.N`) publish the same way.

### API stability

**From the first release candidate (RC.1) the public API is frozen.** The public API is everything exported from the four entry points: `@green-tea/core`, `/deno`, `/bun` and `/edge`.

- **RC.1 to stable: fixes only.** No release in that window adds, removes, renames or narrows a public API. It also deprecates nothing. If a fix needs an API change, the freeze is reopened, and the change is called out under `### Breaking` in the CHANGELOG.
- **After stable, deprecations come before removals.** A deprecated API keeps working for at least two monthly releases. It carries JSDoc `@deprecated` naming its replacement. Where it has a runtime path, it warns once per process through `app.logger`, never `console`. It is removed only in a release whose CHANGELOG lists the removal under `### Breaking`.
- **Every API change shows up in review.** [`api/`](./api) holds the committed API report for each entry point, and CI fails when the build no longer matches it. A deliberate change regenerates the report in the same pull request.
- **Mesh is alpha and outside the promise.** It is `@experimental` and gated behind `createApp({ experimental: true })`, so it may change in any release. Mesh adapts to the stable API and never changes it. Its own surface is the exports tagged `@experimental`, the shape of `MeshConfig` behind the `mesh` option, and the `mesh:*` lifecycle events. A mesh change may alter those and nothing else. It cannot add a `createApp` option, an `App` method or a decorator, and it cannot change a stable type. If mesh needs something the stable API does not offer, it builds on what is there. Its exports still appear in the reports, so those changes still show up in review.

## License

[MIT](./LICENSE) © green-tea contributors. Contributions require a [DCO sign-off](./CONTRIBUTING.md).
