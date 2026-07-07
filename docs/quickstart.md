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

## 7. Transport security

Four `createApp` options cover TLS, proxying, CORS, and response headers.

### TLS (native https/wss)

```typescript
import { readFileSync } from 'fs';

const app = createApp({
  modules: [App],
  tls: { key: readFileSync('key.pem'), cert: readFileSync('cert.pem') },
});
```

When `tls` is set the server serves https, and WebSocket upgrades become wss on the same
port — no other changes.

### `trustProxy`

```typescript
const app = createApp({ modules: [App], trustProxy: true });
```

Behind a reverse proxy, reads `X-Forwarded-Proto` / `X-Forwarded-For` to populate
`ctx.protocol` (`'http' | 'https'`) and `ctx.ip` (read via `@ctx()`). Off by default —
forwarded headers are ignored (and spoofable) until you opt in. It trusts the immediate hop
unconditionally; there's no CIDR allowlist yet.

### CORS

Off unless `origins` is set.

```typescript
const app = createApp({
  modules: [App],
  cors: { origins: 'https://app.example.com', credentials: true },
});
```

`origins` accepts `string | string[] | '*' | (origin) => boolean`. A preflight `OPTIONS`
request (with `Access-Control-Request-Method`) is auto-answered with 204.

- With `credentials: true`, the server never sends `Access-Control-Allow-Origin: *` — it
  echoes the concrete allowed origin (or blocks the request).
- **Security warning:** `origins: '*'` together with `credentials: true` reflects *any*
  origin with credentials attached — the classic reflect-any foot-gun. Only combine them if
  you truly intend an open credentialed API; prefer an explicit allowlist.

### `security` (headers, ON by default)

Applied to every HTTP response. Disable everything with `security: false`, or override
individual headers with an options object.

| Header | Default |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Referrer-Policy` | `no-referrer` |
| `X-DNS-Prefetch-Control` | `off` |
| `Strict-Transport-Security` | `max-age=15552000` (180d) — **only when the connection is secure** (native TLS, or `trustProxy` + `X-Forwarded-Proto: https`); no `includeSubDomains`/`preload` |
| `Content-Security-Policy` | not set — pass `security: { csp: "..." }` |

```typescript
const app = createApp({ modules: [App], security: { csp: "default-src 'self'" } });
```

**Scope caveat:** `security` and `cors` headers apply to HTTP responses; they do not apply
to the WebSocket handshake (101/upgrade) response.

### Defaults

| Option | Default |
|---|---|
| `tls` | off (plain http/ws) |
| `trustProxy` | off |
| `cors` | off (same-origin only) |
| `security` | ON (HSTS only when the connection is secure) |

## 8. File uploads / multipart

A request with `Content-Type: multipart/form-data` makes `@body()` resolve to `{ fields, files }`
instead of a plain object:

```typescript
import { Route, Post, body } from '@green-tea/core';
import type { MultipartBody } from '@green-tea/core';

@Route('/profile')
class ProfileController {
  @Post('/avatar')
  upload(@body() form: MultipartBody) {
    const name = form.fields.name;         // string | string[]
    const avatar = form.files.avatar;      // UploadedFile | UploadedFile[]
    return { name, size: Array.isArray(avatar) ? undefined : avatar?.size };
  }
}
```

`UploadedFile` is `{ filename, contentType, data: Buffer, size }` — the whole file is buffered
in memory, no temp files.

> **Access note (asymmetry).** For multipart, `@body('title')` returns `undefined` — the value
> lives at `body.fields.title`, not `body.title`, unlike JSON/urlencoded where `@body('title')`
> picks the value directly. Use `@body()` and read `.fields`/`.files`, or key into the envelope
> itself with `@body('fields')` / `@body('files')`.

### Repeated fields — `bodyDuplicates`

By default, a repeated field name keeps the **last** value (`'last'`, matching urlencoded).
Set `bodyDuplicates: 'array'` on `createApp` to accumulate repeats into a `string[]` instead —
this applies to **both** urlencoded and multipart text fields:

```typescript
const app = createApp({ modules: [ApiModule], bodyDuplicates: 'array' });
```

Files under a repeated field name always become an array (`UploadedFile[]`), regardless of
`bodyDuplicates`.

### Per-endpoint override

```typescript
@Post('/upload', { duplicates: 'array' })
upload(@body() form: MultipartBody) { /* ... */ }
```

Precedence: route `duplicates` → app `bodyDuplicates` → `'last'`.

### Limits

Uploaded files are held in memory, so they're bounded by the same `maxBodyBytes` limit as any
other request body (over the limit → 413). `maxParts` (default `1000`) caps the number of
multipart parts per request:

```typescript
const app = createApp({ modules: [ApiModule], limits: { maxParts: 500 } });
```

A malformed multipart body (bad boundary, missing headers, truncated part) → 400.

## 9. Validation

`@body`, `@query`, `@headers`, and `@param` accept an optional **Standard Schema**
(the [`~standard` interface](https://standardschema.dev) shared by zod, valibot, arktype,
and others). green-tea's core has **zero runtime dependency** on any of them — bring
whichever validator you already use:

```typescript
import { z } from 'zod';
import { Route, Post, body } from '@green-tea/core';

const CreateUser = z.object({ email: z.string().email() });

@Route('/users')
class UserController {
  @Post('/')
  create(@body(CreateUser) user: { email: string }) {
    return { created: user.email };
  }
}
```

The value the handler receives is the schema's **parsed/coerced output**, not the raw
input — `ctx.body` (via `@ctx()` or a `@needs`-fed step) stays exactly what the transport
parsed. Query strings are always strings on the wire, so a schema is often the coercion
point:

```typescript
const ListQuery = z.object({ page: z.coerce.number() });

@Get('/list')
list(@query(ListQuery) q: { page: number }) {
  return { page: q.page, isNum: typeof q.page === 'number' }; // GET /list?page=2 → true
}
```

> **Access shape (asymmetry).** `@param('id', Schema)` takes the key in slot 1 and the schema
> in slot 2 — `@param` always needs a name to say which route param it binds. `@body(Schema)`,
> `@query(Schema)`, and `@headers(Schema)` take the schema as their only argument, validating
> the whole parsed object (all of `body`/`query`/`headers`).

A failing schema short-circuits the request with **422**:

```json
{ "error": "Validation failed", "source": "body", "issues": [{ "path": "email", "message": "Invalid email" }] }
```

`source` is which envelope failed (`'body' | 'query' | 'params' | 'headers'`); `issues` is
the schema's issues flattened to `{ path, message }` (`path` is dot-joined).

**Caveats:**
- **Fail-fast.** Arguments validate in order; the **first** failing one throws — later args in
  the same handler are not checked in that request.
- **Steps see raw input.** Only the resolved handler argument is coerced/validated; a `@Step`
  reading the same data via `ctx.body`/`ctx.query`/etc. always sees the untouched value.
- **A throwing schema is a 500, not a 422.** The Standard Schema contract says `validate()`
  returns `{ issues }` on failure — it isn't supposed to throw. If it does anyway, that
  propagates as an uncaught error (→ 500), since it signals a bug in the schema, not user input.
- **Async schemas are awaited** — `validate()` returning a `Promise` works transparently.

**Not covered yet:** response/output validation, validating a `@Step`'s own inputs, and
mesh remote-route validation are all out of scope for this feature.

## Inspect & test the graph

### Visualize with Mermaid

```typescript
console.log(app.toMermaid());  // flowchart diagram of all nodes and routes
```

Enable a live `GET /__graph__` endpoint (renders HTML with Mermaid, or plain-text with `Accept: text/plain`):

```typescript
const app = createApp({ modules: [ApiModule], devGraph: true });
// GET /__graph__            → HTML viewer
// GET /__graph__ (text/plain) → raw Mermaid source
```

### Explain a route

```typescript
const e = app.explain('/api/users/:id');
// { pattern, method, transport, chain: [{ name, kind, origin, needs, provides }, ...] }
console.log(e.chain.map((n) => `${n.kind}:${n.name}`));
// → ['provider:db', 'step:user', 'handler:getUser']
```

### Override tokens in tests

Swap any provider or step token with a test double at construction time — no monkey-patching:

```typescript
const app = createApp({
  modules: [ApiModule],
  overrides: {
    db: { find: () => ({ id: 'test-user' }) },   // plain object — wrapped as { db: value }
    user: () => ({ user: { id: 'stub' } }),       // function runner
  },
});
```

Overrides replace only the named token's runner; the rest of the graph is untouched.

## Runnable examples

The `example/` directory holds end-to-end apps you can `node`-run and read top to bottom.

### CRUD — methods, query, JSON & urlencoded body

`@Get/@Post/@Put/@Patch/@Delete` over a provider-backed store. Filter via `@query('done')`,
read the payload via `@body()` — the same handler accepts both `application/json` and
`application/x-www-form-urlencoded` (the transport parses each into a plain object). Missing
rows throw `NotFound` (→ 404).

See [`example/crud.ts`](../example/crud.ts).

### Chat — rooms + handshake auth

A `@Step` reads `?token=` and `provides: 'user'`, throwing `Unauthorized` on a missing token —
which closes the socket with code **4401** (`4000 + status`). The `@Ws` handler pumps the
`@inbound()` channel into `rooms.room(name)` and returns that same room as its outbound channel,
so every joined socket multicasts to the others. `rooms` is the built-in shared `Rooms`
primitive (one instance app-wide).

See [`example/chat.ts`](../example/chat.ts).

### GraphQL — query/mutation over POST, subscription over SSE

A schema built programmatically with `graphql` (a dev/example dependency — the core has no
runtime dep on it). `POST /graphql` runs queries and mutations through `graphql()`. The
`mutation` pushes each new message into `rooms.room('messages')`; the `@Sse('/stream')` route
calls `subscribe()` whose source **is** that room, guards the result with `isAsyncIterable`,
and returns it — the framework streams each `ExecutionResult` as an SSE `data:` frame. This is
the tie between GraphQL, green-tea streams, and the `rooms` primitive.

See [`example/graphql.ts`](../example/graphql.ts) — `npm install graphql` first.

## The one rule to remember

```
return a VALUE          → buffered response (transformer → JSON)
return an AsyncIterable → stream (SSE / WS)
@needs a remote token   → RPC to a teapot (mesh)
```
