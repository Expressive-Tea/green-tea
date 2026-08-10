---
title: createApp options
description: "Every option accepted by createApp and every method on the App it returns."
---

```typescript
const app = createApp(options);
```

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `modules` | `Ctor[]` | — | the `@Module` classes to wire (required) |
| `plugins` | `Plugin[]` | `[]` | plugins, each limited to `bus.on` + `scope.add` ([plugins](/docs/guides/plugins/)) |
| `limits` | `RequestLimits` | see below | body-size and timeout ceilings |
| `devGraph` | `boolean` | `false` | mount `GET /__graph__` ([introspection](/docs/guides/introspection/)) |
| `devOpenapi` | `boolean` | `false` | mount `GET /__openapi__` serving the [OpenAPI](/docs/guides/openapi/) document |
| `overrides` | `Record<string, unknown>` | — | swap any node by token ([testing](/docs/guides/testing/)) |
| `tls` | `TlsOptions` | — | serve over https/wss |
| `trustProxy` | `boolean` | `false` | honor `X-Forwarded-*` for `ctx.protocol` / `ctx.ip` |
| `security` | `boolean \| SecurityOptions` | `true` | secure-by-default headers ([security](/docs/guides/security/)) |
| `cors` | `CorsOptions` | — | CORS handling |
| `bodyDuplicates` | `'array' \| 'last'` | `'last'` | policy for repeated form fields |
| `onError` | `ErrorRenderer` | — | render errors your way ([error handling](/docs/guides/errors/)); returns a response or `undefined` to fall back to JSON |
| `views` | `string` | `process.cwd()` | base dir `@Html('file.html')` paths resolve against — relative paths join it, absolute paths are used as-is ([HTML & views](/docs/guides/html/)) |
| `viewEngine` | `(source: string, data: unknown) => string` | built-in `render` | swap in your own template engine for `@Html(..., { template: true })`; template mode only ([HTML & views](/docs/guides/html/)) |
| `static` | `boolean \| string` | — | serve a directory as a `GET`/`HEAD` fallback (after declared routes, before `404`); `true` → `./public`, a string → that dir; path-traversal-safe; needs a filesystem — Node/Deno/Bun only ([HTML & views](/docs/guides/html/)) |
| `mesh` | `MeshConfig` | — | distributed DI — **requires `experimental: true`** ([mesh](/docs/guides/mesh/)) |
| `experimental` | `boolean` | `false` | opt in to alpha features (currently gates `mesh`) |
| `warnGraphDepth` | `number \| false` | `20` | warn when one route resolves to more than this many steps; `false` disables the design warning |

### `RequestLimits`

| Field | Default |
|---|---|
| `maxBodyBytes` | `1_000_000` (→ `413` when exceeded) |
| `maxConnections` | `1000` (Node only; `<= 0` means unlimited) |
| `requestTimeoutMs` | `30_000` |
| `headersTimeoutMs` | `10_000` |
| `keepAliveTimeoutMs` | `5_000` |
| `maxParts` | `1000` (multipart) |

### `TlsOptions`

`{ key, cert, ca?, passphrase? }` — `key`/`cert` are `Buffer | string`.

### `CorsOptions`

`{ origins, methods?, allowedHeaders?, exposedHeaders?, credentials?, maxAge? }`. `origins` is a string, array, `'*'`, or a `(origin) => boolean` predicate. `credentials: true` is never combined with `'*'`.

### `SecurityOptions`

`{ hsts?, frameOptions?, referrerPolicy?, noSniff?, dnsPrefetchControl?, csp? }`. HSTS is only emitted on secure connections. `csp` is opt-in.

### `MeshConfig`

`{ secret?, teapots?, timeoutMs?, heartbeatMs? }` — `teapots` is `{ url, secret }[]`; `timeoutMs` bounds an RPC (default 30s, → 504), `heartbeatMs` is the ping gap that detects a half-open link (default 15s, → 503). See [Mesh](/docs/guides/mesh/).

## The `App`

`createApp` returns an `App`:

| Member | Returns | Notes |
|---|---|---|
| `listen(port)` | `Promise<http.Server>` | boots providers, then serves |
| `close()` | `Promise<void>` | drains in-flight, closes streams + mesh links |
| `ready()` | `Promise<void>` | resolves the graph and mesh links without booting providers |
| `fetch(request)` | `Promise<Response>` | Web-Standards HTTP/SSE handler for Node, Deno, Bun, and edge |
| `upgrade(request, socket)` | `Promise<void>` | neutral WebSocket upgrade used by non-Node adapters |
| `inspect(route)` | `InspectLine[]` | the provider/step/handler chain for a route |
| `explain(route)` | `Explain` | the chain annotated with each node's needs/provides |
| `graph()` | `GraphView` | the full node + route graph |
| `toMermaid()` / `toDOT()` | `string` | render the graph |
| `openapi(info?)` | `OpenApiDoc` | structural OpenAPI 3.1 document ([details](/docs/guides/openapi/)) |
| `degraded()` | `string[]` | optional providers running degraded (empty until providers boot through `fetch`, `upgrade`, or `listen`) |
| `bus` | `Bus` | lifecycle + request event bus |

:::note
On mesh apps, `graph` / `explain` / `inspect` / `degraded` are only available after `ready()` or the first serving call — the graph is finalized once remote scopes connect.
:::
