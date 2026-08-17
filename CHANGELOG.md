# Changelog

All notable changes to `@green-tea/core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
green-tea uses calendar versioning: `YY.M.PATCH` — the month is not zero-padded, since
npm treats versions as semver and semver forbids leading zeros.

## [Unreleased]

### Added

- Shutdown is now an extension point. A `@Provider` may declare `dispose()`, a plugin may call
  `api.onShutdown(fn)`, and an application may pass `createApp({ hooks: [{ onShutdown }] })` — three
  doors into one registry, so an app closing a connection no longer writes `process.on('SIGTERM')`
  by hand. Callbacks are **awaited**, unlike `bus.on` listeners, and take no arguments: whatever
  needs closing is already in the closure that registered it.

  They run in reverse boot order, so a `cache` that needs `db` closes before the `db` it is holding.
  A failing teardown is logged and the rest still run — one broken callback must not leave the
  process up. Everything happens inside `close()`'s existing deadline; `createApp({ teardownTimeoutMs })`
  reserves a slice of that budget when a connection must get its chance to close, and is rejected at
  boot if it exceeds `shutdownTimeoutMs`.

  Node, Deno and Bun behave identically — on Deno and Bun the teardown runs from the `close()` on the
  server `serveDeno()`/`serveBun()` returned. **The edge cannot participate**: workerd has no
  shutdown to intercept, so anything that must be released belongs in the request that acquired it.

  Nothing changes for existing code. `Plugin`'s signature is unchanged, `Hooks` methods are optional,
  and `dispose()` is called only if present.

- `limits.maxConnections` changes Node's previously unlimited concurrent socket count to a
  default cap of `1000`; values `<= 0` leave Node unlimited. Deno and Bun have no equivalent
  runtime setting and require a platform or reverse-proxy connection cap.

## [26.8.0-beta.0] - 2026-08-02

### Added
- **Safe constrained route parameters:** patterns such as `:id(\d+)` match a complete decoded
  segment. The parser accepts a deliberately small, bounded regex subset and rejects unsafe or
  malformed expressions at boot. Specificity is now static ▸ constrained param ▸ plain param ▸
  catch-all; matching remains a linear scan.
- **`@Head` and `@Options` route decorators**, explicit-handler priority, buffered-GET HEAD fallback,
  and automatic `204` OPTIONS responses with deterministic `Allow` ordering. GET implies HEAD and
  every existing path implies OPTIONS; streaming GET routes do not become implicit HEAD routes.
- **OpenAPI route constraints and methods:** constrained path params emit `schema.pattern`, and
  explicitly declared HEAD/OPTIONS handlers appear as operations without inventing automatic ones.
- **HTML / views:** `@Html` decorator (string, file, and template modes), a zero-dep built-in
  template engine (`{{ }}` escaped / `{{{ }}}` raw, exported as `render`) with a `viewEngine`
  bring-your-own hook, and zero-config `static` directory serving (`createApp({ static: true })`).
  File and static serving require a filesystem (Node/Deno/Bun); string-mode `@Html` runs everywhere.
- **`app.fetch(request): Promise<Response>`** — a Web-Standards handler so the
  same app runs HTTP and SSE on Deno/Bun/edge runtimes via the Fetch API.
- **Deno adapter** (`@green-tea/core/deno`): `serveDeno(app)` runs HTTP + SSE + WebSocket on Deno.
- **Bun adapter** (`@green-tea/core/bun`): `serveBun(app)` runs HTTP + SSE + WebSocket on Bun, reusing the neutral `app.upgrade` / `WsSocket` capability. WebSocket, rooms, and channels behave identically to Node and Deno.
- **Cloudflare Workers / edge adapter** (`@green-tea/core/edge`): `edgeHandler(app)` runs HTTP + SSE + WebSocket on workerd, reusing the neutral `app.upgrade` / `WsSocket` capability. Requires the `nodejs_compat` compatibility flag. Green Tea now runs on Node, Deno, Bun, and the edge — with identical WebSocket, rooms, and channel behaviour on all four.
- **`app.upgrade(request, socket)`**: neutral WebSocket entry point for non-Node runtimes, built on a shared `WsSocket` capability. WebSocket logic is now runtime-agnostic (`src/http/ws-core.ts`).
- **Mesh (alpha) runs on Node, Deno and Bun** — teapot *and* teacup, in any combination
  (a Deno teapot can serve a Node teacup). It no longer needs `app.listen()`: the graph boots on
  first use, so `serveDeno`/`serveBun` work through `app.fetch`/`app.upgrade`. Edge is **not**
  supported — the teapot's secret comparison needs `node:crypto`'s `timingSafeEqual`, which
  `nodejs_compat` does not provide.
- **`MESH_PROTOCOL_VERSION`**: the mesh wire is versioned. Peers exchange it in the `hello`/`manifest`
  frames and refuse a mismatch, naming both versions, instead of misreading each other's frames.
  The teapot checks the version *before* the secret — a skewed peer is not an auth failure.
- **`HttpError` accepts `headers`**, so a custom error can carry its own response headers
  (`retry-after`, `etag`, …) without a special case in the error renderer.
- **`app.ready(): Promise<void>`** — resolves the dependency graph and returns. On a mesh app it
  connects the teapots and splices their scopes in; on every other app it is a no-op, so
  `await app.ready()` before `inspect()`/`graph()`/`explain()` works against either kind without
  knowing which you were handed. It does **not** boot providers: resolving the graph and being
  ready to serve are different things, and drawing a diagram should not open your database
  connections. Serving boots them too and shares the same memoized step.

- **Mesh heartbeat** (`mesh.heartbeatMs`, default 15s): each teacup pings its teapots and closes a
  link after two unanswered rounds, so a half-open connection surfaces as an immediate 503 rather
  than every request paying `timeoutMs` first. Ping/pong are mesh frames, not WebSocket protocol
  pings — the platform `WebSocket` on Deno/Bun does not expose `ws.ping()`.

### Fixed
- The Deno WebSocket adapter snapshots request and connection metadata before accepting an upgrade;
  Deno 2.9 invalidates that metadata once upgraded, which previously broke WebSocket and mesh boots.
- Repeated slashes and malformed path encoding now return `400` consistently across Node and Fetch
  adapters, retaining configured security/CORS headers. `/path` and `/path/` remain equivalent.
- Ambiguous same-method route shapes now fail at boot with both declarations named. Effective-shape
  checks also cover remote mesh conflicts and local routes that shadow a remote export.
- HEAD responses always suppress the body while preserving handler status and headers; Fetch
  responses also avoid constructing forbidden bodies for `204`, `205`, and `304` statuses.
- The opt-in dev routes `/__graph__` (graph viewer) and `/__openapi__` are now
  served over `app.fetch` too, so they work on every runtime (Deno/Bun/edge),
  not only the Node `app.listen()` path.
- **A teapot with a live control channel could never shut down.** Mesh control connections were
  not registered with the stream registry, so `server.close()` waited on a connected teacup that
  had no reason to hang up, and `app.close()` never resolved.
- **A downed teapot now answers 503 immediately** instead of hanging for the full `timeoutMs`
  (30s by default) and then answering 500. A closed socket cannot deliver the frame, so the wait
  bought nothing. An RPC that times out on a live link is now 504, not 500 — a dead upstream and
  a slow one are different operational stories, and neither is "this service broke".
- **`request:step:enter`/`leave` are now emitted for `@Ws` and mesh routes.** Only HTTP routes
  emitted them, so a logging plugin silently observed nothing on a WebSocket route — a gap in a
  documented plugin API. All transports now run their steps through one path.
- **A mesh route exported by two teapots now fails the boot**, naming both effective patterns and
  both teapots, instead of silently serving whichever connected first and leaving the other dead.
  There is no load balancing to fall back on, so green-tea will not pick for you.
- **A local route shadowing a remote one now warns.** Local still takes precedence — that is how you
  override a teapot — but a silently shadowed export used to look like a broken teapot.
- **`app.close()` closes mesh links even with no server**, so a mesh app booted through `app.fetch`
  (every Deno/Bun deployment) no longer leaks its teapot connections.
- **WebSocket frames arriving during boot are no longer dropped.** `app.upgrade` awaited the boot
  before handing the socket to a consumer, and the inbound channel is fan-out, so a peer that spoke
  first lost those frames — for mesh, that was the handshake itself.
- The plugins guide documented a `request:step:exit` event that has never existed; the bus emits
  `request:step:leave`.

### Changed
- Root, runtime-only, and website dependency audits are clean after supported package updates and
  narrow pins for vulnerable transitives. CI audits root + website trees and builds the docs; the
  GitHub OIDC release workflow audits immediately before its publish gate.
- App-scope providers now boot exactly once (memoized): a second `app.listen()`
  call no longer re-runs provider factories or their side effects.
- **`WsOpenCtx.req`** (available in `@Ws`/`@Sse` handlers) is now a neutral
  `WsRequest` (`{ url, headers, protocol, ip }`) instead of the Node
  `http.IncomingMessage`, so it works the same across Node and Deno. Node-only
  fields such as `req.socket` / `req.rawHeaders` are no longer available on
  `ctx.req`; use `ctx.protocol` / `ctx.ip` / `ctx.query` / `ctx.headers`
  instead — all still provided.
- **Breaking (pre-1.0): transport is now enforced by declaration.** A buffered route
  (`@Get`/`@Head`/`@Post`/`@Put`/`@Patch`/`@Delete`/`@Options`) whose handler returns an
  `AsyncIterable`, or a streaming route (`@Sse`/`@Ws`) whose handler returns a plain value, now
  fails with a 500 `TransportMismatchError` instead of silently switching behavior. `@Stream`
  still negotiates both. Declare `@Sse`/`@Stream`/`@Ws` to stream — a return value no longer
  changes a route's wire contract.

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

[Unreleased]: https://github.com/Expressive-Tea/green-tea/compare/v26.8.0-beta.0...main
[26.8.0-beta.0]: https://github.com/Expressive-Tea/green-tea/compare/v26.7.0-beta.0...v26.8.0-beta.0
[26.7.0-beta.0]: https://github.com/Expressive-Tea/green-tea/releases/tag/v26.7.0-beta.0
