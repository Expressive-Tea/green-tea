---
title: Routing
description: "Route patterns, the catch-all, specificity precedence, and 405 handling."
---

Routes are declared with method decorators on a `@Route`-prefixed controller. Patterns are matched **by segment**.

## Method decorators

| Decorator | Method / transport |
|---|---|
| `@Get` `@Post` `@Put` `@Patch` `@Delete` | buffered HTTP response |
| `@Sse` | server-sent events (`text/event-stream`) |
| `@Ws` | WebSocket duplex |
| `@Stream` | negotiated — SSE / ndjson / WS, picked from the client's `Accept` / `Upgrade` |

```typescript
@Route('/users')
class Users {
  @Get('/:id') get(@param('id') id: string) { /* ... */ }
  @Post('/')   create(@body() data: unknown) { /* ... */ }
}
```

The path a route matches is `joinPath(module.mountpoint, route.path)` — a controller under `@Module({ mountpoint: '/api' })` with `@Route('/users')` + `@Get('/:id')` serves `/api/users/:id`.

## Pattern segments

- **Static** — `users` matches exactly.
- **`:param`** — matches exactly one segment; the decoded value lands in `params.name` (`@param('id')`).
- **`:name*` catch-all** — a trailing segment that captures the **rest of the path, slashes included**, into `params.name`.

```typescript
@Get('/files/:path*')   //  /files/img/2026/logo.png  →  params.path = "img/2026/logo.png"
```

A catch-all also matches zero remaining segments (`/files` → `params.path = ""`).

## Precedence

When more than one route matches the same path, the **most specific wins** — `static ▸ :param ▸ catch-all` — compared segment by segment, **independent of registration order**. Genuine ties (two equally-specific patterns) fall back to registration order.

```typescript
@Get('/a/b')      // wins for /a/b
@Get('/a/:id')    // wins for /a/x
@Get('/a/:rest*') // wins for /a/x/y
```

## 404 vs 405

A path that no route matches returns `404`. A path that **does** exist but under a different method returns **`405 Method Not Allowed`** with an `Allow` header listing the methods that do match — not a `404`.

:::note
A bare `OPTIONS` request (without an `Access-Control-Request-Method` header — i.e. not a CORS preflight) to an existing path therefore returns `405` with `Allow`. CORS preflights are handled separately; see [Transport security](/docs/guides/security/).
:::

## Not yet

The matcher is intentionally small for beta. **Not built** (on the roadmap):

- Regex / typed param constraints such as `:id(\d+)`.
- Route matching is a **linear scan** — fine for typical route tables, but a radix-tree matcher for very large ones isn't implemented.

See [Streaming & real-time](/docs/guides/streaming/) for `@Sse` / `@Ws` / `@Stream`, and [Argument decorators](/docs/guides/arguments/) for everything a handler can read from a request.
