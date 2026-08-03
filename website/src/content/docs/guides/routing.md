---
title: Routing
description: "Route constraints, specificity, HEAD and OPTIONS semantics, and path validation."
---

Routes are declared with method decorators on a `@Route`-prefixed controller. Patterns are matched **by segment**.

## Method decorators

| Decorator | Method / transport |
|---|---|
| `@Get` `@Head` `@Post` `@Put` `@Patch` `@Delete` `@Options` | buffered HTTP response |
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
- **`:param(constraint)`** — matches one complete decoded segment when it satisfies a safe regex subset, for example `:id(\d+)`.
- **`:name*` catch-all** — a trailing segment that captures the **rest of the path, slashes included**, into `params.name`.

```typescript
@Get('/users/:id(\\d+)') // /users/42 matches; /users/alice does not
@Get('/files/:path*')   //  /files/img/2026/logo.png  →  params.path = "img/2026/logo.png"
```

A catch-all also matches zero remaining segments (`/files` → `params.path = ""`).

Constraints are anchored to the whole segment automatically. They allow character classes, alphanumeric/literal atoms, the escaped character classes `\d`, `\D`, `\s`, `\S`, `\w`, `\W`, and simple quantifiers (`+`, `*`, `?`, `{n}`, `{n,m}`). Groups, alternation, lookarounds, backreferences, anchors, and other arbitrary regex features are rejected at boot. Expressions are limited to 128 characters, counted quantifiers are capped, and unsafe adjacent unbounded quantifiers are rejected. This deliberately small subset avoids accepting route regexes with obvious ReDoS shapes.

Patterns must start with `/`, parameter names must be unique and use identifier syntax, and a catch-all must be the final segment. Repeated slashes in a declared pattern fail at boot.

## Precedence

When more than one route matches the same path, the **most specific wins** — `static ▸ constrained :param ▸ plain :param ▸ catch-all` — compared segment by segment, independent of registration order.

```typescript
@Get('/a/b')      // wins for /a/b
@Get('/a/:id(\\d+)') // wins for /a/42 over the plain parameter
@Get('/a/:id')    // wins for /a/x
@Get('/a/:rest*') // wins for /a/x/y
```

Two routes under the same method cannot have the same effective shape: `/users/:id` and `/users/:name` are ambiguous and make boot fail with both declarations named. The same rule applies after mesh routes join. Different methods may reuse a shape.

## HEAD and OPTIONS

An explicit `@Head` or `@Options` route always wins. Without an explicit HEAD route, HEAD falls back to a matching **buffered** GET handler, preserves its status and headers, and suppresses the body. Streaming GET routes do not become implicit HEAD routes.

Without an explicit OPTIONS route, OPTIONS on an existing path returns `204` with a canonical `Allow` header. GET implies HEAD, and any existing path implies OPTIONS, so a GET/POST path reports `GET, HEAD, POST, OPTIONS`. A CORS preflight (OPTIONS with `Access-Control-Request-Method`) is handled before explicit or automatic OPTIONS when CORS is configured.

## Path policy and 404 vs 405

`/path` and `/path/` are equivalent. Repeated slashes such as `/path//item` are rejected rather than collapsed, and malformed percent encoding is rejected; both return `400 Bad Request` with the configured security/CORS headers. Query strings do not participate in route matching.

A path that no route matches returns `404`. A path that **does** exist but under a different method returns **`405 Method Not Allowed`** with an `Allow` header listing the methods that do match — not a `404`.

## Matcher scale

Route matching remains a **linear scan** — fine for typical route tables. A radix-tree matcher for very large route tables remains on the roadmap.

See [Streaming & real-time](/docs/guides/streaming/) for `@Sse` / `@Ws` / `@Stream`, and [Argument decorators](/docs/guides/arguments/) for everything a handler can read from a request.
