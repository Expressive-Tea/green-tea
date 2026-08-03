---
title: Decorators
description: "Full reference for every class, method, and argument decorator."
---

Every decorator green-tea exports, grouped by where it applies. All require `experimentalDecorators: true` in your `tsconfig` — see [Why legacy decorators](/docs/concepts/the-graph/#why-legacy-decorators).

## Structure

### `@Module(options)`

Marks a class as a module and records what it wires together.

```typescript
@Module({
  mountpoint: '/api',        // path prefix for this module's controllers (required)
  providers: [Database],     // app-scope @Provider classes
  steps: [Authenticate],     // request-scope @Step classes
  controllers: [UserCtl],    // @Route classes
})
class ApiModule {}
```

### `@Route(prefix)`

Marks a class as a controller; `prefix` is prepended to each route path.

## Providers & steps

### `@Provider(options)`

An app-scope value, built once at boot and cached, addressable by `provides`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `provides` | `string` | — | the token this provider produces (required) |
| `needs` | `string[]` | `[]` | tokens it depends on |
| `optional` | `boolean` | `false` | if it throws on boot, degrade instead of aborting ([details](/docs/guides/dependency-injection/)) |
| `export` | `boolean` | `false` | expose over the mesh control channel ([mesh](/docs/guides/mesh/)) |

### `@Step(options)`

A request-scope transform that merges keys into the context. Same options as `@Provider`.

### `@Transformer(fn)`

Method decorator. Turns a handler's return value into `{ status?, headers?, body }`. `JsonTransformer` is the default.

### `@Html` / `@Html(path, opts?)`

Method decorator. Marks a buffered `GET`/`POST` handler as serving HTML instead of going through the JSON transformer. Three modes ([details](/docs/guides/html/)):

| Form | Behavior |
|---|---|
| `@Html` (bare) | sends the handler's returned string as `text/html` |
| `@Html('file.html')` | serves that file verbatim; the handler's return value is ignored |
| `@Html('file.html', { template: true })` | renders the file with the handler's returned data, via the built-in `render` engine or `viewEngine` ([createApp](/docs/reference/createapp/)) |

Only buffered `GET`/`POST` routes are supported, and `@Html` can't be combined with `@Transformer` on the same handler — both are validated at boot, not per-request.

## Routes

Method decorators on a controller. All accept `(path, opts?)` where `opts = { export?: boolean, duplicates?: 'array' | 'last', maxBodyBytes?: number, maxParts?: number }`. `maxBodyBytes` / `maxParts` override the server-wide [`limits`](/docs/reference/createapp/) for this route only.

| Decorator | Method | Transport |
|---|---|---|
| `@Get` `@Head` `@Post` `@Put` `@Patch` `@Delete` `@Options` | as named | buffered response |
| `@Sse` | GET | `text/event-stream` |
| `@Ws` | GET | WebSocket duplex |
| `@Stream` | GET | negotiated (SSE / ndjson / WS) |

```typescript
@Get('/ping', { export: true })                          // exportable over mesh
@Post('/upload', { duplicates: 'array' })                // repeated form fields → arrays
@Post('/avatar', { maxBodyBytes: 5_000_000, maxParts: 20 }) // per-route upload limits
```

See [Routing](/docs/guides/routing/) for pattern matching and [Streaming](/docs/guides/streaming/) for the transports.

`@Head` and `@Options` declare explicit handlers. When they are absent, the router can provide an implicit buffered-GET HEAD response or an automatic `204` OPTIONS response; those fallbacks are runtime behavior, not decorator metadata.

## Arguments

A handler's signature declares exactly what it wants, in any order.

| Decorator | Injects | Forms |
|---|---|---|
| `@needs('user')` | a graph-produced value (boot-validated) | `('key')` |
| `@ctx()` | the whole accumulated context | `()` |
| `@param(...)` | route params | `()` · `('id')` · `('id', schema)` |
| `@query(...)` | parsed query string | `()` · `('q')` · `(['a','b'])` · `(schema)` |
| `@body(...)` | parsed body (JSON / urlencoded / multipart) | `()` · `('field')` · `(schema)` |
| `@headers(...)` | request headers (whole bag or picked) | `()` · `('authorization')` · `(['a','b'])` · `(schema)` |
| `@header('name')` | one request header (singular alias of `@headers`) | `('x-trace')` · `('x-count', schema)` |
| `@inbound()` | the incoming message stream (WebSocket) | `()` |
| `@abort()` | the request's `AbortSignal` | `()` |

Passing a [Standard Schema](/docs/guides/validation/) validates and coerces the value before the handler sees it. Full details in [Argument decorators](/docs/guides/arguments/).
