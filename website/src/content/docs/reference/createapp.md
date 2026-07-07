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
| `plugins` | `Plugin[]` | `[]` | plugins, each limited to `bus.on` + `scope.add` ([plugins](/guides/plugins/)) |
| `limits` | `RequestLimits` | see below | body-size and timeout ceilings |
| `devGraph` | `boolean` | `false` | mount `GET /__graph__` ([introspection](/guides/introspection/)) |
| `overrides` | `Record<string, unknown>` | — | swap any node by token ([testing](/guides/testing/)) |
| `tls` | `TlsOptions` | — | serve over https/wss |
| `trustProxy` | `boolean` | `false` | honor `X-Forwarded-*` for `ctx.protocol` / `ctx.ip` |
| `security` | `boolean \| SecurityOptions` | `true` | secure-by-default headers ([security](/guides/security/)) |
| `cors` | `CorsOptions` | — | CORS handling |
| `bodyDuplicates` | `'array' \| 'last'` | `'last'` | policy for repeated form fields |
| `mesh` | `MeshConfig` | — | distributed DI — **requires `experimental: true`** ([mesh](/guides/mesh/)) |
| `experimental` | `boolean` | `false` | opt in to alpha features (currently gates `mesh`) |

### `RequestLimits`

| Field | Default |
|---|---|
| `maxBodyBytes` | `1_000_000` (→ `413` when exceeded) |
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

`{ secret?, teapots?, timeoutMs? }` — `teapots` is `{ url, secret }[]`. See [Mesh](/guides/mesh/).

## The `App`

`createApp` returns an `App`:

| Member | Returns | Notes |
|---|---|---|
| `listen(port)` | `Promise<http.Server>` | boots providers, then serves |
| `close()` | `Promise<void>` | drains in-flight, closes streams + mesh links |
| `inspect(route)` | `InspectLine[]` | the provider/step/handler chain for a route |
| `explain(route)` | `Explain` | the chain annotated with each node's needs/provides |
| `graph()` | `GraphView` | the full node + route graph |
| `toMermaid()` / `toDOT()` | `string` | render the graph |
| `degraded()` | `string[]` | optional providers running degraded (empty until `listen()`) |
| `bus` | `Bus` | lifecycle + request event bus |

:::note
On mesh apps, `graph` / `explain` / `inspect` / `degraded` are only available **after** `listen()` — the graph is finalized once remote scopes connect.
:::
