# Changelog

All notable changes to `@green-tea/core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
green-tea uses calendar versioning: `YY.M.PATCH` — the month is not zero-padded, since
npm treats versions as semver and semver forbids leading zeros.

## [26.9.0-beta.2] - 2026-09-22

### Breaking

- **`serveDeno()` and `serveBun()` are async**, returning `Promise<DenoServer>` and
  `Promise<BunServeResult>`. They now boot the app before they bind, which is what `listen()` has
  always done.

  They did not, and the documented fix was to remember to `await app.boot()` first. That made the
  correct use of a core helper depend on reading a README, in a framework whose argument is that
  order should not be something you have to get right. Forget it and a missing signing key is not a
  failed deploy: the boot memo keeps the rejection, so the port binds, every request gets a 500 from
  the runtime, and none of them reach `onError`. The server looks healthy to anything that only
  checks whether it is listening.

  Migration is one keyword, and the value is unchanged:

  ```diff
  - const server = serveDeno(app, { port });
  + const server = await serveDeno(app, { port });
  ```

  Both runtimes support top-level `await`, so a module that serves at import time needs nothing
  else. `edgeHandler` is deliberately untouched: on workerd there is no startup outside a request,
  so there is no earlier moment to move the failure to.

- **A plugin is a named object.** `Plugin` is now `{ name, mount(api) }`; it was `(api) => void`.
  The name that `plugin:mounted` reports came from `fn.name`, which is `""` for an arrow returned
  straight from a factory, `"plugin"` for a `const`, and whatever a minifier leaves behind — so the
  event that exists to report which plugins mounted reported none of them by name. The name is now
  the author's word, a failed `mount` is reported as `plugin "<name>" failed to mount: …` with the
  original error as its `cause`, and two plugins sharing a name fail `createApp`.

  Migration is mechanical:

  ```diff
  - const jwt = (options) => ({ scope }) => { scope.add(node); };
  + const jwt = (options) => ({
  +   name: options.provides ?? 'jwt',
  +   mount({ scope }) { scope.add(node); },
  + });
  ```

- **Mesh (alpha): only steps and routes can be exported.** `@Provider({ export: true })` now fails
  the boot, with an error naming the provider and the replacement. A provider is a factory whose
  value *is* the object it builds — a pool, a client, a `db` — and an object is not what a JSON wire
  carries. What did cross was whatever half of it survived serialization, and it arrived as an
  app-scope binding: the teacup resolved it once at boot and then served that value for the life of
  the process, out of a cache the teapot no longer stood behind. Restarting the teapot, or changing
  what it built, changed nothing on the teacup until the teacup itself restarted.

  Export a `@Step` instead. It runs on the teapot, per request, and only its result comes back —
  which is why the two entries below follow from this one: a remote export now holds nothing between
  requests. `invalidateRemoteBindings`, the `rebind` array and the `onReconnect` callback that drove
  them are gone with it. All three existed to throw away a cached app-scope value when a link came
  back; there is no longer a cached value, so a reconnected link is simply usable again on the next
  RPC. Internal, so nothing importable changed.

  **A teapot that boots today can stop booting**, and the replacement is mechanical: the exported
  `@Provider` becomes a `@Step` that returns what the provider's value carried.

- **Mesh (alpha): the manifest carries step names.** `{ scopes: [{ token, scope }], routes }` is now
  `{ steps: string[], routes }`. Every export is request-scope after the change above, so the
  lifetime field had one possible value left and told a reader nothing. A manifest step that is not
  a string is now rejected on arrival, rather than trusted because a peer sent it.

  `MESH_PROTOCOL_VERSION` deliberately stays at `1`. Mesh is alpha behind `experimental: true`, both
  peers ship from this repository, and there is no deployed pair of versions for a bump to protect —
  it would spend the number on nobody. A stable wire would not get that option; alpha is exactly
  what the word buys, and this is the last comfortable moment to use it.

### Added

- **`app.boot()`** runs the provider factories now instead of on the first request. `listen()`,
  `serveDeno()` and `serveBun()` all call it for you (see Breaking, below). Call it by hand when you
  drive `app.fetch` / `app.upgrade` from your own server: those boot lazily, and the boot memo keeps
  a rejection, so a bad key answers 500 on *every* request, from the runtime, without reaching
  `onError`. On workerd there is no startup outside a request, so calling it moves nothing.
- **Errors are recognised by brand.** `HttpError` and `ValidationError` now carry
  `Symbol.for('green-tea.http-error')` and `Symbol.for('green-tea.validation-error')`, and
  `isHttpError` checks the brand instead of `instanceof`. An error thrown by code holding a
  different copy of core — a plugin package, an app that installed from npm and JSR both — now
  renders with its own status instead of a 500. The exported `HttpErrorLike` type and the
  `isValidationError` guard come with it. The string is the public protocol: code that imports only
  types writes `Symbol.for('green-tea.http-error')` itself.

### Changed

- **Mesh (alpha): an unreachable teapot no longer stops a teacup from booting.** Blocking was never
  caution, it was arithmetic: an app-scope value has to resolve *at boot*, because there is no later
  to resolve it in. A step is nothing but later. The `bootTimeoutMs` grace still waits, since "the
  container is thirty seconds behind" and "the teapot does not exist" look identical for the first
  thirty seconds; exhausting it now warns and starts without that teapot.

  What that buys is narrower than it sounds, and worth stating exactly. A teapot that never
  connected sent no manifest, so the teacup learned nothing about it — no step runners, no routes,
  a graph identical to the one it would have had if that teapot were never configured. Its routes
  therefore **404**, through the ordinary unmatched-route path, because nothing was ever registered
  to match. And any local step or handler that needs one of its tokens **still fails the boot**,
  naming the teapot that did not connect. `503` is what a teapot that connected and *later* died
  answers: that link exists, its steps and routes are registered, and the dead link is what returns
  the status. Never reachable and reachable-then-gone are different situations, and they read
  differently on purpose.

  So the change is for the teacup that does *not* depend on that teapot: it starts, rather than
  refusing over a dependency it never had. It is not graceful degradation of the dependency, and
  cannot be — answering `503` for an absent teapot's tokens means knowing what it *would* have
  exported, and only a declaration can say. That declaration is the `expects` list in
  `docs/plans/2026-08-18-mesh-degrade-plan.md`, which is planned and not built. Two things are
  unchanged: a **permanent refusal** — a wrong secret, a protocol mismatch — still fails the boot
  without spending the grace, because it is the teapot's decision rather than the network's and will
  be the same decision in thirty seconds; and the missing-token error, which now says "local or
  connected mesh" rather than "local or mesh", the old wording having claimed a search that never
  happened.

## [26.9.0-beta.1] - 2026-09-04

### Added

- **A request budget, not just a connection cap.** `createApp({ limits: { maxConcurrentRequests } })`
  bounds how many handlers run at once, per server and per Fetch adapter instance; over the budget a
  request gets `503` with `Retry-After: 1` instead of queueing behind the ones already running. It is
  opt-in and unlimited by default, and it counts *executing handlers* rather than open connections —
  the slot is released when routing and the handler finish, so a long-lived SSE stream or a WebSocket
  upgrade does not hold one for its lifetime. On Node a client disconnect releases the slot early. A
  handler that never returns keeps its slot, which is the honest behaviour for a budget of this shape.
  Contributed by @hgshreyas.

  Node's connection cap also stopped being silent: reaching `maxConnections` now logs a warning
  naming the dropped peer, rate-limited to one a minute. Until now the socket was destroyed with no
  HTTP response and nothing said so, which reads from the outside like a network fault.

- **`createApp({ handleSignals: true })` registers `SIGINT`/`SIGTERM` to close and exit.** Off by
  default, and that is the design rather than caution: a library that installs process-wide handlers
  behind your back is worse than one that installs none, because when the process exits is the
  application's call. Both halves are supported — keep the handler, or hand it over. What is not
  optional either way is that *something* calls `close()`; the teardown registry only runs from
  there, so a container `SIGKILL`ed after its grace period skips every `dispose()` and reports
  nothing.

  Declared once and wired per runtime by whichever boot call runs — `listen()`, `serveDeno()` and
  `serveBun()` each attach it to the closer that drains *their* server, so `process.on` on Node and
  Bun and `Deno.addSignalListener` on Deno stop being the application's problem. `close()`
  unregisters, which means a *second* signal falls through to the platform default and ends the
  process at once: Ctrl-C twice is the way out of a teardown that is stuck.

- **The extension-point types are exported, not just the extension points.** `TransformerFn` — the
  type of `@Transformer`'s only argument — could not be imported, so a custom transformer was
  attached with its shape redeclared inline or borrowed off a value as `typeof JsonTransformer`.
  Checking the barrel for the same oversight turned up four more, all now exported: `PluginApi`,
  `ScopeApi` and `ScopeNode`, the chain reached through `api.scope.add`, without which a plugin split
  into named functions cannot annotate what it receives; plus `Hooks` and `TeardownFn`. Types only —
  nothing at runtime moved and no existing export changed.

- **The lifecycle stream has a contract now, not just events.** `request:end` is documented as
  terminal and universal — it fires for every request shape and is the only one carrying the status
  the client received, which makes it the request counter. `request:failed` means *handler code
  threw*, which no status expresses on its own since a rendered `422` is also a throw, and
  `route:unmatched` means *no route ran*. Both are **additional** to `request:end`, not alternatives
  to it: one failing request emits three events and a 404 emits two, all sharing a `requestId`, and
  an exporter that treats them as separate outcomes counts the same request twice. Silently — the
  metrics just come out wrong.

  `request:failed` now carries `status`, so an error counter can break down by status without
  joining back through `requestId` for something the emitter already had. It is absent in exactly
  one case: a custom `onError` that threw while producing it, where the framework does not know what
  was sent and will not guess.

- **`@needs('events')` reaches the read-only half of the bus** — `{ on }`, the same narrowing
  plugins already get, exported as the `Events` type. `app.bus` was public and a plugin could
  subscribe, but the bus was not a graph token, so `@needs('bus')` failed at boot and nothing said
  why. It still is not one, and that is the design: handing `emit` to every node turns a one-way
  observation channel into something anything can forge events on. `@needs('bus')` now fails saying
  exactly that, and pointing at the two things that do work.

  A plugin remains the right home for observation, because it gets `on` and `onShutdown` *together*.
  This token gives the subscribe half alone — `on()` returns its own unsubscribe for a `@Provider`
  to release in `dispose()`, and a `@Step` should not subscribe at all, since it runs per request
  and would add a listener each time.

- **`@Sse` can emit an `id:`, so an `EventSource` reconnect has something to resume from.**
  `sse(data, { id, event, retry })` tags a stream item and the encoder writes the fields ahead of
  `data:`; an app that never calls it produces byte-identical output. Until now the encoder wrote one
  field, so the browser had nothing to put in `Last-Event-ID` and every automatic reconnect — the
  reason to choose SSE over a raw WebSocket — rebuilt the route's iterable from its start and lost
  the gap in silence. The other half already worked: the request envelope has always carried every
  header, so a handler could already read `@header('last-event-id')`; it simply always arrived empty.
  `event:` and `retry:` come along because the same envelope carries them, and neither was reachable
  before.

  **green-tea stores nothing** — no buffer, no retention window, no replay. It carries the marker in
  both directions and the handler decides what the gap means, because only the source knows: a paged
  log re-reads from an offset, a live sensor has no past worth delivering. An `id` containing a
  newline is rejected rather than stripped, since the SSE format is line-based and an id is exactly
  the value most likely to be built from a request — a cursor, a page token — so one newline would
  let a caller append fields to somebody else's stream. On an `ndjson` or `negotiate`-to-ndjson route
  the payload is unwrapped and the fields dropped. New exports: `sse`, `isSseEvent`, `SseEvent`,
  `SseFields`.

### Changed

- **A request's security and CORS headers are computed once.** They were derived twice per request
  and three times for a preflight — once in the adapter, to seed the headers a response written
  before routing still has to carry, and again during dispatch. Nothing was incorrect, but
  `cors.origins` is a predicate precisely so it can be a lookup: an allowlist in Redis, a tenant
  query. Running it two or three times charged the caller's latency budget and their backend for an
  answer whose inputs had not changed in between, and made a predicate with a counter in it count
  double.

- **Every `request:end` is now preceded by a `request:start` carrying the same `requestId`.** The
  pairing held by accident until `maxConcurrentRequests` arrived: `request:start` had a single
  emitter, so nothing could break it, and a shed request emitted only the `request:end`. A consumer
  that opens per-request state on the first and closes it on the second — an in-flight gauge, most
  obviously — would have drifted under shedding, which is when an operator is reading it, and would
  have done so by producing a plausible wrong number rather than an error. It is a guarantee now,
  written next to `LifecycleEvent` and enforced by a test that enumerates every response shape.

- **An unmatched request carries a bounded `route`.** `route:unmatched` was the one terminal request
  event with no `route`, so the only subject a consumer could reach was `name` — which on that event
  is the concrete, caller-controlled path. A matched path is bounded by the route table; an
  unmatched one is bounded by nothing, and a scanner walking `/aaa`, `/aab`, `/aac` is a memory leak
  with a metrics backend attached. It and the `request:end` that follows now carry
  `route: '<unmatched>'`, exported as `UNMATCHED_ROUTE`. Written down alongside it: `name` is
  caller-controlled and must never be a metric label.

- **Framework token names are reserved.** `logger`, `rooms`, `events` and `bus` cannot be declared
  by a module, plugin or mesh export; taking one is a boot error naming it. Built-ins used to be
  registered only if the name was free, so a provider called `logger` silently replaced the
  framework's own and every `@needs('logger')` in the app got something that was not the logger core
  writes to — a divergence discovered from a log line that never appeared. `bus` is reserved without
  being provided, so `@needs('bus')` cannot resolve to whatever a user happened to call `bus`.

  **This can fail an app that boots today**, which is the point of it, and the fix is to rename.

- **No per-request bookkeeping when no request budget is set.** Every request registered a `close`
  listener and set a flag for `maxConcurrentRequests`, which is opt-in and unlimited by default — so
  most applications paid a closure and an `EventEmitter` registration per request, on the hot path,
  for a feature that was off. Unchanged where a budget *is* configured: the listener is what
  releases a slot when a client disconnects mid-handler.

- **Route ranking is settled when the route table is built, not on every request.** Matching scanned
  every route registered under the request's method and ranked the candidates as it went, deriving
  each pattern's specificity from its source string per comparison. Both the scan and the ranking
  scale with the size of the route table, and neither can produce a different answer between two
  requests — the table is assembled once, after the graph is prepared, and handed to the adapter
  unchanged. Routes are now compiled, bucketed by method and ordered most-specific-first once, and
  matching returns at the first route that matches.

  Nothing about which route answers changes. Equal specificity still keeps registration order, which
  the ordering carries through a stable sort rather than through a scan that declined to replace its
  best on a tie. Two smaller savings ride along on the same path: a path segment holding no `%` skips
  `decodeURIComponent` entirely, and decoding is memoized per request rather than repeated for every
  candidate route that reaches the same parameter position.

  Worth nothing on a small route table and worth a great deal on a large one, which is the shape of
  the saving rather than a caveat on it: **no measurable change at 6 routes, +3.4% at 50, and +12% to
  +14.9% at 200**. That is also why it went unnoticed for two releases — the benchmark had no
  route-table-width dimension until this one, so every matcher change measured as noise regardless of
  its size.

- **Independent providers boot concurrently.** Boot walked the topological order one node at a time,
  so an application paid the *sum* of its providers' latencies rather than its longest chain — three
  providers with no edges between them and 200ms of work each took 616ms for a graph whose critical
  path is 200ms; it now takes 210ms. The graph already proved which nodes cannot constrain each
  other, and flattening the sort was the only thing throwing that away: the ordered list is grouped
  back into dependency levels and each level runs together, with level *N* fully registered and
  warmed before *N+1* starts. Nothing the graph derives changes, and this is the second thing users
  get for declaring `needs`/`provides` rather than ordering calls by hand — pruning was the first,
  and neither is available to a middleware chain, where nothing declares what is independent.

  Two consequences worth knowing. Teardown still runs in the exact reverse of boot: registration
  follows level order rather than completion order, which is what keeps that a guarantee instead of
  a race. And a required provider that fails no longer prevents its independent siblings from
  starting — they are already in flight — so whatever they opened is registered for teardown before
  the boot is aborted. On the bus, `boot:provider:start` no longer strictly alternates with `:ok`; a
  level emits its starts together and then its results.

### Fixed

- **A `cors.origins` predicate that throws no longer takes the process down.** The predicate runs on
  the request path, above the region where errors convert to a response, so a throw became a rejected
  promise nobody awaited — and Node's default for that is to exit. One cross-origin request was
  enough, `onError` never saw it, and the trigger is a browser: the predicate is only reached when an
  `Origin` header is present, so no test that forgets the header can catch it. A predicate that throws
  now **denies** the origin and the failure is logged. A lookup that failed has not said yes, and a
  broken allowlist must never widen into an open one.

- **The JSR package works.** JSR serves `src/` rather than the tsup build, and the ESM build's
  `createRequire` banner therefore never existed there — so every lazy `require()` in the source had
  nothing to resolve. `@Html('file')` and template mode died at boot on Deno with `ReferenceError:
  require is not defined`. Two other sites were worse than the crash because they answered
  confidently and wrongly: `static` reported *"needs a filesystem and is unavailable on this runtime
  (edge)"* while running on Deno, which has one, and multipart reported `busboy` as not installed
  while it sat in `node_modules`. Both blamed the runtime for a packaging problem, and both named a
  runtime the reader was not on.

  Every call site now resolves through one helper that prefers the ambient `require` — so both npm
  builds behave exactly as before — and otherwise rebuilds one from
  `process.getBuiltinModule('node:module')`, which Node, Deno and Bun all expose synchronously. On
  workerd, which offers neither, nothing changes and the guarded sites' "edge has no filesystem"
  story is finally the true one.

- **A custom `onError` that throws no longer takes the process down.** `createApp({ onError })` is
  the advertised way to render errors, it runs on the request path, and it ran with no boundary — a
  renderer that threw exited the process, exit code 1. It is the same shape as the CORS predicate
  crash above and easier to reach: not a cross-origin request, but *any* request that produces an
  error. The renderer produces the 404 too, so an app with a custom renderer and no matching route
  was one request away from exiting.

  It was also the worst-timed crash there was, since the renderer only runs once something has
  already gone wrong: an error occurs, the code written to report it fails, and instead of a
  degraded report the server ends. A renderer that throws now falls back to the built-in rendering —
  which is exactly what the option overrides — so the original error still gets its response, and
  the renderer's own failure is logged separately, naming both.

- **A stream's lifecycle is reported on every runtime, and joins back to its request.** `stream:open`,
  `stream:close` and `stream:error` were emitted only by the Node adapter. Every Fetch runtime — Deno,
  Bun, workerd, and `app.fetch()` on Node — emitted none of them and broke the response with a
  transport error instead of writing the encoder's error frame. Both halves were silent: a consumer
  counting `stream:error` saw zero on three of the four runtimes while streams were failing normally,
  and the client got a truncated body indistinguishable from a clean end of stream. The Fetch path now
  emits all three and frames the error before closing cleanly, which is what the Node adapter always
  did and the better answer for the client — an SSE consumer that received an `error` event knows what
  happened, where a dropped connection tells it nothing.

  All three events now also carry the opening request's `requestId` and `traceId`, plus a bounded
  `route`. `src/http/core.ts` had documented them as carrying the id since the stream landed; they
  never did. The split they exist for is deliberate — a route returning an `AsyncIterable` is done in
  milliseconds while its connection may live for hours, so `request:end` fires at the handler's return
  and hour-long connections stay out of the same latency distribution as 2ms replies — but it only
  works if the two can be *joined*, and without the id an exporter could not say which request opened
  the connection still holding a slot. A WebSocket upgrade correlates itself: it is an HTTP request
  with headers like any other, so it adopts a gateway's `x-request-id` rather than opening a second
  identity, and carries `transport: 'ws'`.

## [26.8.0-beta.1] - 2026-08-19

### Added

- **Observability: a correlated lifecycle event stream and an injectable logger.** Every request is
  given an id — an incoming `x-request-id` is adopted rather than replaced — and every event of that
  request carries it, alongside the matched route _pattern_ (never the concrete URL, which would give
  a metrics backend one label per distinct path). Each step reports its own duration. `createApp({
logger })` accepts any object with `debug`/`info`/`warn`/`error`; the default writes structured JSON,
  or a readable line on a TTY, decided once at boot. Nothing in core writes to `console`, enforced by a
  lint rule rather than by intention. `createApp({ logRequests: true })` logs one line per request, off
  by default. New exports: `Logger`, `LogLevel`, `LogFields`, `createDefaultLogger`,
  `withConsoleFallback`, `logRequests`, `LifecycleEvent`, `EventPayload`, `Correlation`.

  No metrics registry and no OpenTelemetry exporter in core — those live outside it, because core
  keeps one runtime dependency. A `traceparent` header is carried through untouched for an exporter to
  interpret; core implements no propagation spec. Closes [#10](https://github.com/Expressive-Tea/green-tea/issues/10).

- **A bounded `close()` on the Deno and Bun adapters**, and `createApp({ shutdownTimeoutMs })` for the
  Node one. `app.close()` returns at its no-server guard on Deno and Bun, so the deadline lives on the
  server `serveDeno()`/`serveBun()` returns. One difference the deadline cannot hide: Node and Bun
  force the remainder shut, while Deno cannot — aborting a server that is already draining throws from
  Deno's own listener, so there the deadline bounds how long `close()` waits, not when connections die.

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

### Changed

- **A request that crosses the mesh keeps its identity.** The RPC envelope now carries the caller's
  `requestId` and `traceId`, and a teapot adopts them rather than opening a new investigation — the
  same rule an incoming `x-request-id` already got, applied at the process boundary where a trace
  matters most. It also carries `url`, so a proxied handler sees the path its caller asked for.

  Both fields are **optional on the wire and the protocol version does not move**: `decode` validates
  only what a frame type requires and passes extras through, so a teapot on an older green-tea
  ignores them and keeps answering. That is degraded, not broken. The rule for when the version
  _does_ move is now written next to the constant, because "bump on any breaking change" never said
  what counts as breaking.

  The remote-route envelope is also built explicitly instead of cast from the internal request
  object, which had been putting `ip` and `protocol` on the wire — fields the protocol never
  declared and a teapot could have come to depend on.

- **Boot waits for a teapot that is merely slow, and still fails for one that is absent.**
  `createApp({ mesh: { bootTimeoutMs } })` gives a teacup a grace period — default `timeoutMs`, so
  30s — in which a teapot that has not finished starting is retried with backoff. When it passes,
  the boot still fails, because a provider the graph depends on is not optional: booting without it
  would only move the failure to the first request, where it becomes a caller's 503 instead of the
  deploy's error. `bootTimeoutMs: 0` restores a single attempt.

  **A refusal is not retried.** A wrong secret or a protocol-version mismatch is the teapot's
  decision and will be the same decision in thirty seconds, so it fails immediately rather than
  spending the whole budget to reach an identical error. The two are told apart by whether the
  socket ever opened — a peer that accepted the connection and then hung up rejected us on purpose;
  one that never accepted it may simply not be listening yet.

  Every retry is logged _and_ emitted as the new `mesh:boot:retry` lifecycle event, so a slow boot
  is visible to whatever collects events and not only to whoever is watching a terminal.

- **`.` and `..` in a request path are now resolved rather than 404'd.** `GET /public/../admin` reaches
  a route declared as `/admin`, and `%2e` counts as a dot, so the encoded spelling cannot reach a route
  the plain one resolves away from. This is a **behaviour change on Node only**, and it exists to end a
  divergence: Deno, Bun and Workers resolve dot segments inside the `Request` constructor before the
  framework sees anything, so the same bytes on the wire already reached different routes depending on
  where you deployed. Rejecting them — the stricter option, and what this module does for `//` — is not
  implementable on three of the four runtimes. If a proxy or WAF in front of you matches on the literal
  path, note that it sees `/public/...` where the application now routes `/admin`.

### Fixed

- **A mesh export that carried behaviour arrived as `{}`, with HTTP 200 and no warning.** The wire is
  JSON, so a value with methods — a connection pool, a client, a `Map` — lost everything but its
  shape in transit. What reached the caller was an object: truthy, passing any `if (db)` check, and
  missing every method, so the failure surfaced as `db.query is not a function` at a call site
  arbitrarily far from the export that caused it.

  A teapot now refuses to send one, on the side that still holds the real value, with a message
  naming the token and what sat where: `mesh cannot transport 'db': result.db is a Pool instance`.
  The check is an allowlist — primitives, plain objects, arrays — so `Date` is refused too, since it
  would arrive as a string rather than the type the caller declared, which is the same silent
  difference in a smaller costume. It is bounded by a scan budget, so a large legitimate payload is
  never turned into an error by the cost of checking it.

  **This is a constraint the documentation never stated:** a mesh export carries _data_, never
  behaviour. Export what a handle produces, not the handle.

- **A mesh teacup now reconnects to a teapot that came back.** A dropped link used to stay dead for
  the life of the process: every RPC answered 503 until the teacup was restarted, so deploying a
  teapot forced a restart of every teacup that depended on it, and boot order became load-bearing.
  Links now reconnect with exponential backoff and jitter (500ms doubling to 30s), tunable through
  `mesh: { reconnect: { initialDelayMs, maxDelayMs } }` and disabled with `reconnect: false`.
  `close()` is terminal — a link the application hung up on never reconnects, so `app.close()` cannot
  leave a process that refuses to exit.

  A returning teapot whose manifest no longer exports something the graph was validated against at
  boot is **refused** rather than adopted, named by `mesh: { onManifestChange: 'refuse' }`, which is
  the default and currently the only policy. The link keeps retrying, since a partial deploy may
  still restore it, and logs the refusal once per distinct manifest rather than once per attempt.
  Serving against a manifest that no longer backs the graph would surface as a 500 that looks like
  application code. Extra exports in a returning manifest are ignored: the graph is fixed at boot.

  This also closes the documented gap where **an app-scope export outlived its teapot with a stale
  value** — a successful reconnect re-registers those bindings, so the next resolve re-runs the RPC.

  Mesh remains **alpha** and behind `experimental: true`.

- **`mesh:rpc:error` reported the wire id where every other emitter reports a name.** A failing
  remote call emitted `name: "0"` — the per-link request counter — so the teacup's event could not be
  lined up with the teapot's event for the same failure. It now names the token or route.

- **A teapot now bounds its own handshake and caps the size of a control frame.** The teacup has
  always timed out its side; the teapot had no equivalent, so an unauthenticated peer could hold a
  socket open forever by simply never sending `hello`. And `decode` runs `JSON.parse` on
  peer-controlled input _before_ authentication, with no ceiling below whatever the WebSocket layer
  allowed — 100 MiB under the `ws` package's defaults. Frames above 4,000,000 characters are now
  refused with close code 1009, sized above the 1 MB default body limit a legitimate RPC can carry.

- **A `ws://` teapot on a non-loopback host now warns at boot.** The shared secret travels verbatim
  in the `hello` frame, so an unencrypted link puts it in front of anyone on the path. A warning
  rather than a refusal, since a private network doing its own mutual TLS is a real deployment and
  green-tea cannot tell the two apart.

- **Buffered response bodies are narrowed to what the host runtime's `Response` accepts.** A Node
  `Buffer` is a `Uint8Array` at runtime but its declared backing store admits `SharedArrayBuffer`, which
  `BodyInit` does not — so Deno's types rejected it. This was a real typing hole on the `app.fetch`
  path, which is the path Deno, Bun and the edge all use, rather than a JSR formality.

- **`close()`'s shutdown timer is armed before `finish()` is referenced.** The previous ordering relied
  on `server.close(cb)` deferring, which is Node's behaviour rather than a guarantee to us, and left a
  `ReferenceError` waiting in the shutdown path for whoever changed it.

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
- **Mesh (alpha) runs on Node, Deno and Bun** — teapot _and_ teacup, in any combination
  (a Deno teapot can serve a Node teacup). It no longer needs `app.listen()`: the graph boots on
  first use, so `serveDeno`/`serveBun` work through `app.fetch`/`app.upgrade`. Edge is **not**
  supported — the teapot's secret comparison needs `node:crypto`'s `timingSafeEqual`, which
  `nodejs_compat` does not provide.
- **`MESH_PROTOCOL_VERSION`**: the mesh wire is versioned. Peers exchange it in the `hello`/`manifest`
  frames and refuse a mismatch, naming both versions, instead of misreading each other's frames.
  The teapot checks the version _before_ the secret — a skewed peer is not an auth failure.
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

[26.9.0-beta.2]: https://github.com/Expressive-Tea/green-tea/compare/v26.9.0-beta.1...v26.9.0-beta.2
[26.9.0-beta.1]: https://github.com/Expressive-Tea/green-tea/compare/v26.8.0-beta.1...v26.9.0-beta.1
[26.8.0-beta.1]: https://github.com/Expressive-Tea/green-tea/compare/v26.8.0-beta.0...v26.8.0-beta.1
[26.8.0-beta.0]: https://github.com/Expressive-Tea/green-tea/compare/v26.7.0-beta.0...v26.8.0-beta.0
[26.7.0-beta.0]: https://github.com/Expressive-Tea/green-tea/releases/tag/v26.7.0-beta.0
