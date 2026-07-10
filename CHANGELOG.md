# Changelog

All notable changes to `@green-tea/core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
green-tea uses calendar versioning: `YY.MM.PATCH`.

## [Unreleased]

### Added
- **`app.fetch(request): Promise<Response>`** — a Web-Standards handler so the
  same app runs HTTP and SSE on Deno/Bun/edge runtimes via the Fetch API
  (WebSocket and mesh remain Node-only).
- **Deno adapter** (`@green-tea/core/deno`): `serveDeno(app)` runs HTTP + SSE + WebSocket on Deno.
- **Bun adapter** (`@green-tea/core/bun`): `serveBun(app)` runs HTTP + SSE + WebSocket on Bun, reusing the neutral `app.upgrade` / `WsSocket` capability. WebSocket, rooms, and channels behave identically to Node and Deno.
- **Cloudflare Workers / edge adapter** (`@green-tea/core/edge`): `edgeHandler(app)` runs HTTP + SSE + WebSocket on workerd, reusing the neutral `app.upgrade` / `WsSocket` capability. Requires the `nodejs_compat` compatibility flag. Green Tea now runs on Node, Deno, Bun, and the edge — with identical WebSocket, rooms, and channel behaviour on all four.
- **`app.upgrade(request, socket)`**: neutral WebSocket entry point for non-Node runtimes, built on a shared `WsSocket` capability. WebSocket logic is now runtime-agnostic (`src/http/ws-core.ts`).

### Changed
- App-scope providers now boot exactly once (memoized): a second `app.listen()`
  call no longer re-runs provider factories or their side effects.
- **`WsOpenCtx.req`** (available in `@Ws`/`@Sse` handlers) is now a neutral
  `WsRequest` (`{ url, headers, protocol, ip }`) instead of the Node
  `http.IncomingMessage`, so it works the same across Node and Deno. Node-only
  fields such as `req.socket` / `req.rawHeaders` are no longer available on
  `ctx.req`; use `ctx.protocol` / `ctx.ip` / `ctx.query` / `ctx.headers`
  instead — all still provided.

## [26.7.0-beta.0] - 2026-07-07

First public beta, published under the npm `beta` dist-tag. The API may still
change before the stable release.

### Added
- **Transport security** — native TLS termination (https/wss), CORS with a
  guarded preflight and credentials-safe origins, secure-by-default response
  headers (nosniff, X-Frame-Options, Referrer-Policy, HSTS-when-secure), and
  proxy-aware `trustProxy` exposing `ctx.protocol` / `ctx.ip`.
- **Input validation** — `@body/@query/@param/@headers` accept any
  [Standard Schema](https://standardschema.dev) (zod / valibot / arktype); the
  parsed value is passed to the handler, invalid input returns `422` with
  per-field issues. Core stays dependency-free.
- **Body parsing** — JSON and `application/x-www-form-urlencoded` out of the
  box; `multipart/form-data` file uploads (`@body()` → `{ fields, files }`) via
  the optional [`busboy`](https://github.com/mscdex/busboy) peer dependency
  (a multipart request without it returns `501`), with a configurable
  repeated-field policy (`bodyDuplicates`, per-route overridable) and a
  `maxParts` DoS bound.
- **Routing** — `:name*` catch-all params, specificity-based precedence
  (static ▸ `:param` ▸ catch-all, independent of registration order), and
  `405 Method Not Allowed` with an `Allow` header when a path exists under a
  different method.
- **Argument decorators** — `@needs/@ctx/@param/@query/@body/@headers/@inbound/
  @abort`, plus `@header('name')` as a singular alias of `@headers`.
- **Streams** — SSE / ndjson / WebSocket duplex over a multicast
  `AsyncIterable` channel, with backpressure and cleanup; `rooms` broadcast hubs.
- **Graph introspection** — `app.explain(route)`, `app.graph()`,
  `app.toMermaid()` / `toDOT()`, and an opt-in `GET /__graph__` dev endpoint.
- **Operational hardening** — request body/size limits (`413`), request and
  keep-alive timeouts, and `app.close()` graceful shutdown (drains in-flight
  requests, closes live streams and mesh links).
- **Visible degradation** — optional providers that fail at boot are
  summarized on `listen()` and queryable via `app.degraded()`, instead of a
  silent warning.
- **Testing ergonomics** — `createApp({ overrides })` swaps any provider/step
  by token in one line.
- **Mesh (alpha, walking skeleton)** — `teapot`/`teacup` distributed dependency
  injection over a secret-gated WebSocket control channel. Gated behind
  `experimental: true`; `createApp` throws if `mesh` is configured without it.
- **Packaging** — dual **ESM + CommonJS** builds behind an `exports` map, with
  matching type declarations; one runtime dependency (`reflect-metadata`),
  `ws` and `busboy` optional peers.
- **Benchmarks** — reproducible `npm run bench` harness vs Express 5, Fastify 5,
  NestJS, and raw `http`; results in [BENCHMARKS.md](./BENCHMARKS.md).

[Unreleased]: https://git.svc.zoit.services/Green-Tea/core/compare/26.7.0-beta.0...develop
[26.7.0-beta.0]: https://git.svc.zoit.services/Green-Tea/core/releases/tag/26.7.0-beta.0
