---
title: Argument decorators
description: "Everything a handler can inject with needs, ctx, param, query, body, header, inbound, and abort."
---

A handler's signature declares exactly what it wants — in any order, nothing more. Each
parameter decorator injects one thing: a graph-produced value, part of the request envelope,
or a stream handle. Some decorators add a **dependency edge** to the graph (boot-validated);
most just read from the request.

## The decorators at a glance

| Decorator | Injects | Adds a graph dependency? | Forms |
|---|---|---|---|
| `@needs('user')` | a value produced by a provider/step (boot-validated) | **yes** | `('key')` |
| `@ctx()` | the whole accumulated context | no | `()` |
| `@param(...)` | route params | no | `()` · `('id')` · `('id', schema)` |
| `@query(...)` | parsed query string | no | `()` · `('q')` · `(['a','b'])` · `(schema)` |
| `@body(...)` | parsed body (JSON / urlencoded / multipart) | no | `()` · `('field')` · `(schema)` |
| `@headers(...)` | request headers (whole bag or picked) | no | `()` · `('authorization')` · `(['a','b'])` · `(schema)` |
| `@header('name')` | one request header (singular alias of `@headers`) | no | `('x-trace')` · `('x-count', schema)` |
| `@inbound()` | the incoming WS message channel | no (WS only) | `()` |
| `@abort()` | an `AbortSignal` that fires on disconnect | no (stream/WS) | `()` |

## `@needs` — a graph-produced value

`@needs('token')` injects a value a provider or step produces, and declares a dependency edge
in the graph. Its keys are **validated at boot**: if nothing provides the token, `createApp`
throws with a clear error instead of serving `undefined`.

```typescript
getUser(@needs('user') user: any, @param('id') id: string) {
  return { requested: id, you: user };
}
```

See [Dependency injection](/docs/guides/dependency-injection/) for how `needs`/`provides` build the
graph.

## `@ctx` — the whole context

`@ctx()` hands you the entire accumulated context — everything providers and steps have merged
in, plus built-ins. Use it to read values like `ctx.protocol` and `ctx.ip` (populated when
`trustProxy` is on).

## Envelope decorators — `@param`, `@query`, `@body`, `@headers`

These read from the parsed request. Each envelope decorator has **three access forms**:

- `@query()` — the whole object
- `@query('q')` — one key
- `@query(['q','date'])` — a subset

```typescript
@Get('/:id')
getUser(@param('id') id: string) { /* ... */ }
```

- **`@param`** reads route params. It always needs a name to say which param it binds
  (`@param('id')`).
- **`@query`** reads the parsed query string. Query values are always strings on the wire — a
  schema is often the coercion point (see below).
- **`@body`** reads the parsed body. It handles `application/json`,
  `application/x-www-form-urlencoded`, and `multipart/form-data` (see the multipart note).
- **`@headers`** reads request headers — the whole bag (`@headers()`), one key
  (`@headers('authorization')`), or a subset (`@headers(['a','b'])`).

## `@header` — one header, singular alias

`@header('name')` is the singular alias of `@headers`: it picks exactly one request header.

```typescript
who(@header('x-trace') trace: string) { /* ... */ }
```

It also accepts a schema in slot 2 — `@header('x-count', schema)`.

## Schema forms — validation & coercion

`@body`, `@query`, `@headers`, and `@param` accept an optional **Standard Schema** (zod,
valibot, arktype, …). The value the handler receives is the schema's **parsed/coerced output**,
already typed:

```typescript
create(@body(CreateUser) user: { email: string }) {
  return { created: user.email };
}
```

:::note[Access shape (asymmetry)]
`@param('id', Schema)` takes the **key in slot 1** and the schema in slot 2 — `@param` always
needs a name to say which route param it binds. `@body(Schema)`, `@query(Schema)`, and
`@headers(Schema)` take the schema as their **only** argument, validating the whole parsed
object.
:::

A failing schema short-circuits the request with **422**. See [Validation](/docs/guides/validation/)
for the full contract (fail-fast order, error shape, async schemas, and caveats).

## Multipart access asymmetry

A request with `Content-Type: multipart/form-data` makes `@body()` resolve to `{ fields, files }`
instead of a plain object.

:::caution[Access note]
For multipart, `@body('title')` returns `undefined` — the value lives at `body.fields.title`,
not `body.title`, unlike JSON/urlencoded where `@body('title')` picks the value directly. Use
`@body()` and read `.fields` / `.files`, or key into the envelope itself with `@body('fields')`
/ `@body('files')`.
:::

```typescript
upload(@body() form: MultipartBody) {
  const name = form.fields.name;         // string | string[]
  const avatar = form.files.avatar;      // UploadedFile | UploadedFile[]
  return { name, size: Array.isArray(avatar) ? undefined : avatar?.size };
}
```

## Stream decorators — `@inbound` and `@abort`

These are for streaming handlers:

- **`@inbound()`** (WS only) gives you the incoming WebSocket message channel — the client's
  messages to consume. A `@Ws` handler returns the **outbound** channel.
- **`@abort()`** (stream / WS) hands you an `AbortSignal` that fires on disconnect, so you can
  tear down work when the client goes away.

```typescript
@Ws('/echo')
echo(@inbound() incoming: AsyncIterable<string>) {
  const out = channel<string>();
  (async () => {
    for await (const msg of incoming) out.push(`echo: ${msg}`);
    out.close();
  })();
  return out;
}
```

See [Streaming](/docs/guides/streaming/) for SSE, WebSocket duplex, and channels.

## Where to go next

- How injected values are produced: [Dependency injection](/docs/guides/dependency-injection/).
- The mental model: [The graph](/docs/concepts/the-graph/).
- Validating and coercing injected values: [Validation](/docs/guides/validation/).
- The full API surface: [Decorator reference](/docs/reference/decorators/).
