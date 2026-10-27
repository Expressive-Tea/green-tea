# Changelog

All notable changes to `@green-tea/core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
green-tea uses calendar versioning: `YY.M.PATCH` — the month is not zero-padded, since
npm treats versions as semver and semver forbids leading zeros.

## [Unreleased]

### Breaking

- **Response header values are `string | string[]`** (#113, D11). `TransformerFn`, `ErrorResponse.headers`,
  `HttpError.headers` / `HttpErrorLike.headers` and the pipeline's `ResponseShape.headers` widen from
  `Record<string, string>`, so a response can carry several `Set-Cookie` lines. Code that *produces*
  headers is unaffected; code that *reads* `headers[k]` from one of these types as a `string` stops
  compiling and must handle the array. A `set-cookie` array is sent as one header line per element
  on Node, Deno, Bun and the edge — before, the fetch adapters stringified it into one broken
  `a,b` cookie. Any other array is sent as one line joined with `, `. Injected security and CORS
  headers stay authoritative, and a handler's `vary` array is merged with the injected one.

- **Node 18 and Node 20 are no longer supported; the minimum is Node 22.** Both are end-of-life
  and receive no security patches, so `engines.node` is now `>=22`, CI runs Node 22 only, and the
  build targets `node22`. Node 22 is the oldest line still maintained. The `node:crypto` fallback
  for Node 18's missing global `crypto` is removed with it.

- **Inbound WebSocket messages are capped at 1 MiB by default** (#107). Node used `ws`'s own
  default of 100 MiB, and Deno, Bun and the edge applied no cap of their own, so one client could
  make the server hold a message of any size the runtime would accept. A larger message now closes
  the connection with `1009` (`message too large`). Raise it with `limits.maxWsMessageBytes`.

- **A connection with 16 unread inbound messages is closed on the 17th** (#107), with `1013`
  (`inbound queue full`). The queue behind `inbound` was unbounded on every runtime, so a handler
  that read slowly — or never — let a client grow it without limit. This also reaches a `@Ws`
  handler that never reads `inbound` at all: on Node those frames used to be discarded, and they
  now count. Raise the bound with `limits.maxWsQueue`.

- **A constrained route param that ties with a sibling, or makes one unreachable, now fails boot**
  (#127). Before, the router picked by registration order, and nothing reported it.
  Two routes of the same method that branch at the same segment under the same prefix fail
  `createApp` when:

  - both are constrained, their constraints accept a common segment, and the rest of both patterns
    can match one request. The error names both declarations and a witness:
    `/u/:id(\d+)` + `/u/:n(\d{1,3})` → `both match '0' (GET /u/0)`. Different spellings of one
    language (`\d+` and `[0-9]+`) count. `/u/:id(\d+)/a` + `/u/:n(\d{1,3})/b` share digits but
    no request, so they still boot.
  - a plain param is next to a constraint that accepts every segment (`[^]*`, `[\s\S]+`) and
    outranks it. The error names the dead route and the one that wins.

  A plain param next to a constraint that leaves some segments over is the fallback pattern and
  still boots: `/u/:id(\d+)` + `/u/:slug` routes digits to `:id` and everything else to `:slug`. An
  unescaped `.` does not match line terminators, so `/algo/:a(.*)` leaves `/algo/%0A` to a plain
  sibling, and that pair boots too.

  WebSocket routes are checked under their own precedence, which is declaration order. So a plain
  WS param declared before a constrained one now fails as unreachable. A `@Stream` route sits in
  both tables and is checked under both. Mesh routes exported by different teapots are checked
  against each other. A local route against a remote one keeps the deliberate local override and
  its warning.

  To fix a pair that now fails, make the router's choice explicit. Make the two constraints
  disjoint (`\d{1,3}` and `\d{4,}`), keep one route and branch inside its handler, or move one
  under a static segment of its own (`/u/:id(\d+)` and `/u/short/:n(\d{1,3})`). A plain param
  reported as unreachable never answered a request: delete it, or narrow the constraint that
  shadows it so some segments are left over. For a WebSocket pair, declare the constrained route
  first.

  The check is exact. The safe subset makes every constraint a sequence of (character set, min,
  max) blocks, and the check walks the product of two such sequences. It costs
  O(|A|·|B|·(|A|+|B|)·K) per pair, with K ≤ 2048. Measured at under 0.1 ms for `\d{0,2048}`
  against `[0-9]{0,2048}`, and about 90 ms for the largest product the 128-character limit allows.
  It runs once at boot, and lookup is unchanged. One case is not compared yet: two *different*
  constraints at a later segment of an otherwise unreachable route. The route then boots, as
  before.

- **Edge WebSocket upgrades no longer trust `cf-connecting-ip` by default** (#119). `edgeHandler`
  copied the header into `ctx.ip` on every upgrade, so any client that sent it chose its own
  address. It now counts only under `trustProxy: true`, the same rule HTTP follows. Without it,
  `ctx.ip` on an edge WebSocket is `''`, as it already was on edge HTTP: workerd exposes no peer
  address. An app behind Cloudflare that keys anything on the WebSocket IP needs
  `createApp({ trustProxy: true })`.
- **A token has one producer: a second one fails `createApp`** (GitHub #35). The graph kept the
  last node registered for a token, and plugin nodes are registered after module nodes, so a
  plugin whose `scope.add` provided `user` silently replaced the app's own `@Provider({ provides:
  'user' })` for every route that needed it. Boot now fails instead, naming both nodes and where
  they came from: `token 'user' is provided twice: by 'user' (module:AppModule) and by 'shadow'
  (plugin)`. The rule covers the whole graph (modules, plugins, mesh steps spliced at boot, and
  the built-ins `logger`, `rooms` and `events`), so a plugin node that provides `logger` under
  another name fails as well, whatever order things are registered in. `overrides` keep working:
  they replace the runner of an existing token and add no producer. Observer steps that provide
  nothing are unaffected. The official plugins already follow name = node name = token.
- **`/__mesh__/control` is reserved in every app, mesh or not** (#126). A `@Ws`, `@Stream` or HTTP
  route that claims it — `@Ws('/__mesh__/control')`, `@Get('/__mesh__/control')`,
  `@Ws('/__mesh__/:x')`, `/__mesh__/:rest*`, or a mountpoint that adds up to one of these — now
  fails `createApp`, naming the declaration and the reserved path. A route exported by a teapot is
  checked the same way, and fails the teacup's boot. Before, the Node listener served a user route
  there whenever no mesh control channel was configured, while `app.upgrade` (Deno, Bun, the edge)
  always refused it, so the same route worked on one runtime and not the others. A pattern whose
  first segment is not the literal `__mesh__` (`/:org/:repo`, `/:rest*`) still boots; the reserved
  path is answered ahead of the route table on every runtime, so such a route never sees it.
  To migrate, move the route to another path, for example `/mesh/control`. Nothing replaces
  `/__mesh__/control` itself: it never reached the route on Deno, Bun or the edge.

  An upgrade to `/__mesh__/control` on an app with no control channel is now refused identically
  everywhere: the Node listener accepts it and closes `1008` with
  `mesh control channel not enabled: this app exports nothing, or has no mesh.secret`, as
  `app.upgrade` already did. An app with no `@Ws`/`@Stream` routes and no mesh attaches no upgrade
  listener on Node, as before, so there the request still reaches the HTTP route table.

- **Static files are revalidated, not re-downloaded** (#114, D12). Every static hit carries a weak
  `ETag` (`W/"<size>-<mtime>"`), `Last-Modified` and `Cache-Control: no-cache`. A matching
  `If-None-Match`, or `If-Modified-Since` when there is no `If-None-Match`, answers `304` from the
  file's `stat` without reading it. A `HEAD` no longer reads the file either. `no-cache` stops
  browsers from reusing a file for a lifetime they guessed from `Last-Modified`. To keep the old
  behaviour, set `static: { cacheControl }` to whatever your proxy expects.

- **A node that needs the token it provides fails `createApp`** (GitHub #43). The graph check
  skipped a dependency whose producer was the node itself, so a step with `needs: ['user']` and
  `provides: ['user']` booted, and at request time read a value nobody had written. It now fails
  as the cycle it is, naming the token and the fix: `cycle detected: auth -> auth (it needs 'user',
  which only it provides). Remove 'user' from its needs, or move the work that produces 'user' into
  a step it needs.` Since a token has one producer (GitHub #35), no other node can supply it; only a seeded
  token (`req`, `params`) still satisfies a node's own need, because the node reads the seed.
  `overrides` do not exempt the node: they replace its runner after the graph is checked. To
  migrate, remove the token from the node's `needs`, or move the work that produces it into a
  separate provider or step the node needs.

- **A handler that returns `undefined` answers `204 No Content`** (GitHub #38). The default JSON
  transformer passed the value to `JSON.stringify`, which returns `undefined` rather than a string:
  the Node server sent an empty `200` with `content-type: application/json`, and the fetch adapter
  threw a `TypeError`, so Deno, Bun and the edge answered `500` for a handler that did nothing
  wrong. Every runtime now sends `204` with no body and no `content-type`. A handler that returns
  `null` still gets `200` with `null`. A client that checked for `200` after a handler with no
  `return` sees `204` instead; return a value to keep a `200`. A route with its own `@Transformer`
  is not affected.

### Added

- **Health probes: `createApp({ health: true })`** (#115). Off by default. `GET`/`HEAD /__live__`
  answers `200 {"status":"ok"}` whenever the process answers. `/__ready__` answers
  `503 {"status":"booting"}` until `boot()` resolves, then `200 {"status":"ok"}` or
  `200 {"status":"degraded","degraded":[…]}` (from `app.degraded()`), and
  `503 {"status":"draining"}` from the moment `close()` starts: Node `app.close()`, and the
  `close()` that `serveDeno()`/`serveBun()` return. Probes are answered by the adapter, ahead of
  `maxConcurrentRequests` and the route table, so they are never shed and run no step, provider,
  plugin or `onError`, and emit no lifecycle event (`logRequests` and metrics plugins do not see
  them). Security headers still apply, plus `cache-control: no-store`; other methods get `405` with
  `Allow: GET, HEAD`. While `health` is on, a route at either path fails the boot, local or spliced
  from a teapot. A probe through `app.fetch` before the boot starts the boot without waiting for it.

  `health: { drainDelayMs }` (default 0) keeps the listener open that long after `close()` starts,
  with `/__ready__` already answering `503`, before connections drain. Without it Node closes idle
  keep-alive connections at once, so a probe usually sees a refused connection rather than a `503`.
  The window is spent out of the shutdown budget; `createApp` throws when `drainDelayMs` plus
  `teardownTimeoutMs` exceeds `shutdownTimeoutMs`, and on any `health` value other than `true`,
  `false` or `{ drainDelayMs?: number }`. On the edge there is no `close()`, so `/__ready__` never
  reports `draining` there.

- **`createApp({ compression })`** (#112, D13): response compression, off by default. `true`, or
  `{ threshold?, encodings? }` (default `1024` bytes and `['br', 'gzip']`, in preference order).
  `Accept-Encoding` is negotiated with q-values, `identity`, `*` and `q=0`, and ties go to server
  preference. Text, JSON, JavaScript, ndjson, SVG, XML and wasm are compressed. A response that
  already has `Content-Encoding` or `Content-Range`, has no `Content-Type`, or says
  `Cache-Control: no-transform` is left alone. `Vary: Accept-Encoding` is added wherever the request
  decided the outcome: identity clients, `HEAD`, bodies under the threshold and every `304`.
  `Content-Length` is dropped from an encoded body. SSE and ndjson streams are compressed too,
  flushed after every event, error frame and ping, so each event decodes when it arrives.
  Per runtime:
  - **Node and Bun:** async `node:zlib`, br at quality 4.
  - **Deno:** the same code, but Deno 2.9 runs zlib's async API on the main thread, so compression
    costs event-loop time there (about 4× slower than Node for a 51 KB gzip under load).
  - **Edge:** core never encodes and sets only `Vary`; Cloudflare applies the encoding. Edge is
    recognised through `edgeHandler` or by detecting workerd at `createApp`.

  ETags (`etag: true`) are taken before encoding and stay the same across codings. No dependency;
  invalid options throw.

- **`createApp({ etag: true })`** (#114, D12): weak ETags for buffered `200` responses to `GET` and
  `HEAD`, from a 32-bit FNV-1a hash of the body plus its length. A matching `If-None-Match` (weak
  comparison, lists, `*`) gets a `304` with no body. A handler that sets its own `etag` keeps it, and
  that tag drives the comparison. Streams, non-200 responses and other methods are never tagged.
  The handler still runs. Off by default; anything but a boolean throws at `createApp`.
- **`static: { dir?, cacheControl? }`** (#114): the object form of `static` sets the
  `Cache-Control` sent with static files and their `304`s (for example
  `'public, max-age=31536000, immutable'` for hashed assets). `static: true` and `static: '<dir>'`
  keep working. An unknown key, or a `cacheControl` with CR/LF, throws at `createApp`.

- **`@cookie('name')` / `@cookies()` argument decorators and `setCookie()`** (#113). Cookies are
  parsed from the request's `Cookie` header on first use per request (RFC 6265: first value wins,
  `%`-sequences decoded, malformed pairs skipped rather than answered with a 400), on HTTP and
  WebSocket routes; `@needs('cookies')` gives the same map. OpenAPI lists a cookie argument as an
  `in: cookie` parameter. `setCookie(name, value, options?)` returns a `Set-Cookie` value with
  `HttpOnly`, `SameSite=Lax`, `Path=/` and `Secure` by default (D10; `secure: false` opts out), and
  throws, naming the field, on a name outside the token set, a value with CR, LF, `;`, `,`,
  whitespace or a control character, an attribute with CR/LF, `;` or a control character, and on
  `sameSite: 'none'` or `partitioned` without `secure`. `parseCookies()` and `CookieOptions` are
  exported too. No dependency: signing and sessions stay out of core.

- **`limits.maxWsMessageBytes` and `limits.maxWsQueue`** (#107): per-connection bounds on inbound
  WebSocket messages, in bytes and in unread messages, server-wide on every runtime. `createApp`
  throws a `TypeError` for anything but a positive integer. Node and Bun refuse an oversized message
  before buffering it; Bun before 1.4 does so by dropping the connection, so its peer sees `1006`
  rather than `1009` (Bun 1.4 and later send `1009`). Deno and workerd expose no such option, so there the message is received in full and then
  refused, and its memory is bounded by the platform's own cap. Worst-case buffered inbound memory is
  about `maxConnections × maxWsQueue × maxWsMessageBytes`, ≈ 15.6 GiB at the Node defaults; Deno and
  Bun have no connection cap, so set one at the platform or proxy there.

- **`WsSocket.drained()`** (#41): an optional method an adapter's socket provides so the outbound
  pump can wait for its send buffer. It resolves once the buffer is at or below the adapter's
  high-water mark, or the socket has closed, and at once when it already is. The built-in adapters
  all provide it. A socket built without it is never waited on, as before.

- **Types you could see but not name are now exported** (D19): `AppOptions` (the options object of
  `createApp`, until now an inline type, so `const opts: AppOptions = …` works), `ExplainNode`
  (one entry of `Explain.chain`), and `WsRequest` / `WsSocket` (the arguments of `app.upgrade`).

- **`RequestHeaders`** (D19): the type of the incoming request headers, under a name that does not
  shadow the Fetch `Headers` global. `Headers` remains as a deprecated alias.

### Changed

- **The mesh's exports are marked `@experimental`** (D19): `connectLink`, `buildRemote`,
  `envelopeFrom`, `buildManifest`, `createMeshControl`, `MESH_CONTROL_PATH`, `Manifest`,
  `RequestEnvelope`, `Frame` and `MeshConfig`. They stay exported, unchanged. The mesh already needs
  `createApp({ experimental: true })`; the tag says the same thing in the types: these are outside
  the API freeze and may change in a minor release.
- **Every `304` is bodiless** (#114). A `304` has no body and no `content-*` headers on any adapter,
  including one from `throw new NotModified()`, which used to go out with the default JSON
  envelope's `content-type`.

- **HTTP route lookup uses a radix index** (#109). The router used to scan a specificity-sorted
  list per method, and on every 404 and 405 it recompiled and matched every route to build `Allow`.
  It now walks a tree per method, built once from the route table, with mesh routes from teapots
  in a tree of their own. This is internal and changes no behaviour: the same route wins, with the
  same params, `Allow`, implicit `HEAD` and 404/405, checked against the frozen parity corpus.
  `graph()`, `explain()` and `openapi()` still read the declared routes, not the tree. Median lookup
  time against the old matcher (jarvis, `bench:lookup`): at 500 routes, static hit −54%, late
  param hit −88%, method miss −94%, path miss −96%; at 10 routes, every cell is within noise or
  faster (late param hit +3.4%, 95% CI −5.0…+12.6%).

- **A query string keeps every `?` after the first** (GitHub #48). `parseQuery` took the text
  between the first and second `?`, so `/search?q=what?now` gave `q: 'what'` and dropped the rest.
  RFC 3986 §3.4 allows `?` inside a query, so the query string is now everything after the first
  `?` and before `#`, if there is one: `q: 'what?now'`, and `/search?a=1&b=?` gives `b: '?'`. URLs
  with a single `?` parse as before. Path extraction is unchanged.

- **Mesh (alpha): a teacup's remote routes follow which teapots are connected** (#124, D15). The
  route table used to be built once at boot: a teapot that started late was never served, and a
  teapot that was gone for good stayed advertised. Now:

  - A teapot that missed `bootTimeoutMs` is retried in the background with the `reconnect` backoff.
    When it connects, its routes are served, with no restart. Its steps are not added, because the
    graph was validated at boot without them. With `reconnect: false` it is not retried.
  - While a link is reconnecting, its routes stay and answer `503`, now with `retry-after` (the
    seconds until the next attempt). `Allow` keeps them.
  - A link that gives up for good has its routes removed: they answer `404` and leave `Allow`. That
    is a link dropped with `reconnect: false`, or one refused permanently (a wrong secret, a protocol
    mismatch) while reconnecting. A refused reconnect used to retry forever. It now stops.
  - A returning teapot's routes replace its old ones: a route it added is served, one it dropped
    answers `404`. A returning manifest is still refused for a missing **step**
    (`onManifestChange: 'refuse'`), but no longer for a missing route.
  - A late route that conflicts with another teapot's (same shape, or a CARD-13 sibling conflict)
    is refused and logged, and the rest keep serving. At boot the same conflict still fails boot.
  - A late or returning route on a reserved path (`/__mesh__/control`, and `/__live__`/`/__ready__`
    with `health` on) is refused and logged the same way. At boot it still fails boot.
  - Every change emits `mesh:routes` with `{ url, added, removed }` (new `EventPayload` fields).

  Membership changes publish a new table. A request in flight routes against the old one or the
  new one, never a mix. Only the remote route trees are rebuilt. `listen()` now reads the same
  table as `app.fetch`, and `createHttpServer` accepts a getter as well as an array. Dev
  introspection routes (`devGraph`, `devOpenapi`) now sit before remote routes in that table, so
  in the one case where a teapot exports the same path at the same specificity, the dev route wins.

- **The Node request path does less per request.** A request without a body (no
  `Transfer-Encoding`, no or a zero `Content-Length`, RFC 9112 §6.3), which is every `GET`, no
  longer touches the request stream at all. A JSON `POST` reads its body with stream
  listeners instead of `for await`, which cost a promise and a microtask per chunk; the response is
  written without an `async` wrapper when nothing needs awaiting, and without building the
  compression request when compression is off; the `content-length` limit check runs its shape test
  only for a body that would be refused. Behaviour is unchanged: the same `413`s, the same
  rejection when a client goes away mid-body.

### Deprecated

- **The `Headers` type** (D19). Import `RequestHeaders` instead: same type, a name that does not
  shadow the Fetch `Headers` global in the files that import it. `Headers` stays as an alias, so
  nothing breaks.

### Fixed

- **A `@Module` without a `mountpoint` names itself at boot** (GitHub #31). The type
  requires it, but JavaScript or transpile-only code could still omit it, and `createApp` failed
  with `Cannot read properties of undefined (reading 'replace')` from inside the path helper. It now
  fails with `<Module> @Module metadata is missing mountpoint`. `mountpoint: ''` still mounts at the
  root.

- **The body parser is chosen by the media type** (GitHub #36). It was chosen by a substring of
  the raw `Content-Type` header, case-sensitively, so `Content-Type: Application/JSON` reached the
  handler as a string while `text/plain; x=application/json` was parsed as JSON. The same applied
  to urlencoded and multipart bodies. The parser now compares the media type, the part before any
  `;`, trimmed and lowercased, exactly. Any `+json` type (RFC 6839) is parsed as JSON too:
  `application/problem+json` and `application/vnd.api+json`, which used to arrive as text, now
  arrive parsed, and `application/json-patch+json`, which matched the old substring, still does.

- **Two concurrent `close()` calls both wait for teardown** (GitHub #45). The teardown registry
  marked itself drained and returned at once to any second caller, so a `close()` from a signal
  handler and another from a test hook ran teardown once, but only the first waited for it: the
  second resolved while a database could still be open. Every caller now gets the promise of the
  teardown already in flight, and it still runs once.

- **A graceful close that throws synchronously no longer rejects `close()`** (GitHub #47). On Deno
  and Bun, `closeWithDeadline` called the graceful path directly, so a throw before it returned a
  promise escaped as a rejection of `close()`, while the deadline timer stayed armed and later
  forced the server and logged a timeout nobody was waiting for. A synchronous throw is now handled
  like a rejection: `close()` resolves, and the timer is cleared.

- **A client leaving an idle stream ends it at once** (GitHub #40). Both stream adapters waited for
  the source's pending `next()` after the client had gone, so an SSE feed with nothing to send kept
  its connection alive: on Node, `stream:close` never fired and the stream stayed registered for
  graceful shutdown; through `app.fetch`, cancelling the body did not settle. The pull is now raced
  against the disconnect, and the source's `return()` is called without being waited on, so one
  that hangs or throws can no longer hold up or break the cleanup. Compressed streams included.

- **Decorating a subclass no longer changes its base class** (GitHub #44). The argument
  decorators (`@query`, `@param`, `@needs`, …) and the route decorators (`@Get`, `@Ws`, …) read
  their metadata with `Reflect.getMetadata`, which walks the prototype chain, and then pushed into
  what came back. On a subclass that was the base class's own map or array, so a `@query` on
  `Child.list` also appeared in `getArgs(Base, 'list')`, and a route declared on `Child` was served
  by `Base` too. Each decorator now writes a copy onto the class it decorates. The subclass still
  starts from what it inherits.

- **An app-scoped binding runs its factory once, however many resolve it at once** (GitHub #46).
  The internal container cached the value only after the factory settled, so two resolutions that
  started before then each ran it. It now caches the pending promise. A rejection is still not
  cached: the next resolution retries, as before, and the callers already waiting share that one
  rejection. `createApp` was not affected in practice, because it runs each provider once during
  the memoized boot and registers the finished value, but the container no longer depends on that.

- **A multipart text field over 1 MiB is no longer cut short** (GitHub #39). busboy applies its
  own 1 MiB `fieldSize` default unless told otherwise, so with `maxBodyBytes` raised above that a
  1,100,000-character field reached the handler as its first 1,048,576, and nothing said it had
  been cut. A field is now bounded by the route's body limit, the same one the whole body is held
  to. If busboy still reports a field as truncated, the request fails with `413` rather than
  handing the handler partial data. The Node server and `app.fetch` parse multipart through the
  same path, so the fix applies to both.

- **`maxParts: N` accepts exactly N parts** (#118). busboy signals its parts limit once the count
  reaches it, so a body of exactly `maxParts` parts was rejected with `400 Invalid multipart body`
  and only N−1 got through. busboy now gets one part of headroom, the same way `fieldSize` does:
  N parts are accepted and N+1 are rejected, as the option's name says. Both the route-level and
  the server-level `maxParts` were affected, on the Node server and `app.fetch` alike.
- **`@header('Content-Type')` finds the header** (GitHub #37). Every adapter stores request
  header names lower-cased, and `@header`/`@headers` looked the name up as written, so any name
  with a capital letter reached the handler as `undefined`. The name is now matched without case.
  `@headers(['X-Trace'])` keeps the names as written in the bag it hands over, so the handler reads
  `X-Trace` back; `@headers()` with no argument still returns the lower-cased bag. Node, Deno, Bun
  and the edge share this path.
- **The npm ESM build loads on Cloudflare Workers** (#93). tsup gives every ESM file a
  `createRequire(import.meta.url)` banner so the lazy `require('ws')`/`require('busboy')` work, and
  it ran at module scope. On workerd `import.meta.url` is not a file URL, so `createRequire` threw
  and the whole worker failed to load: `@green-tea/core/edge` from npm could not be used at all.
  The edge suite never noticed because it bundles `src/`. The call is now guarded; where it fails,
  `require` is left undefined and the existing fallback takes over. `npm run test:edge` now also
  builds and boots the published `dist/` on workerd. Node, Deno, Bun and JSR are unchanged.

- **`listen()` rejects when the port is taken** (#138). A bind failure such as `EADDRINUSE` or
  `EACCES` arrives as the server's `error` event, which `listen()` did not handle: the promise
  never settled, and the error surfaced as an unhandled one. It now rejects with that error. The
  app counts as never having listened, so `close()` resolves and a second `listen()` can try
  another port.

- **WebSocket outbound respects backpressure** (#41). A `@Ws` handler's async iterator was pulled
  as fast as it could yield, whatever the peer read, so a fast producer and a slow client grew the
  send buffer without limit: 10,000 frames of 64 KiB put 640 MiB in memory at once. The pump now
  waits before each pull while the socket's buffer is over 1 MiB, an internal mark rather than an
  option, so a slow peer holds at most about that plus one frame. A peer that keeps up never makes
  it wait. If the peer goes away while the pump waits, the wait ends and the iterator's `return()`
  runs, as on any other close. Each runtime signals in its own way: Node uses `ws`'s
  `bufferedAmount` and send callback, Bun uses `getBufferedAmount()` and its `drain` callback, and
  Deno polls `bufferedAmount`, since its `WebSocket` has no drain event. **workerd reports no
  buffered amount**, so on the edge the pump never waits and buffering is left to the platform.

- **On Deno, a `@Ws` handler that yields at once no longer loses the connection.** Deno hands the
  socket over before it is open. A value yielded in that window was pulled, the pump found the
  socket not open, and it gave up: the client got no frame and a close without a code (`1005`).
  The pump now waits for the socket to open, as part of the same backpressure wait.

- **A mesh RPC whose body is within `maxBodyBytes` reaches the teapot again** (#120). The 1 MiB
  WebSocket cap from #107 also bounded the mesh control channel, so a request body that fit the
  HTTP limit could still exceed it once the teacup wrapped it in an RPC frame. A text body near
  1 MB was enough, because JSON escaping doubles every `"` and backslash, and any body limit raised
  above 1 MiB was capped at 1 MiB on the channel. Either way the teapot closed the whole channel
  with `1009`, and every request through that link failed with `503` until it reconnected.

  The control channel is now bounded by the teapot's `limits.maxBodyBytes`: six times the body
  limit, the most JSON escaping can grow a body (a control character becomes `\u0001`), plus 1 MiB
  for headers and the rest of the envelope. That is 7,048,576 bytes at the 1 MB default, up from
  the frame parser's former fixed 4,000,000. `limits.maxWsMessageBytes` still governs every user
  `@Ws` route, unchanged. On Bun, which takes one native payload limit for all sockets, a teapot
  raises that limit to the control channel's bound, so an oversized frame on a user route is
  refused by the framework instead: still `1009`, on every Bun version, where Bun before 1.4
  refused natively by dropping the connection (`1006`).

  The larger bound applies only once the peer's `hello` is accepted. Until then the channel takes
  hello-sized frames (64 KiB), and on Node a peer that sends more than that before its hello is
  dropped before `ws` assembles the frame. Bun and Deno have no per-socket limit for the framework
  to hold that to, so there an unauthenticated peer can still make the teapot receive one frame up
  to the channel's bound before refusing it. If untrusted peers can reach a Bun or Deno teapot's
  `/__mesh__/control`, limit frame size at the proxy in front of it.

- **More than 16 mesh RPCs in flight on one link no longer drop the control channel** (#148). The
  16-frame inbound queue from #107 (`limits.maxWsQueue`) also applied to the control channel. On
  Node, `ws` delivers every frame of one socket read at once, so a teacup sending a burst of RPCs
  got the channel closed with `1013`, and every pending request failed with `503`. The control
  channel now has its own queue bound of 4,096 frames, or `maxWsQueue` if that is larger, which is
  more than one socket read can carry. User `@Ws` routes keep closing `1013` at `maxWsQueue`. Deno
  and Bun deliver frames one at a time and did not hit this, but they now share the same bound.

  Both larger bounds, this one and the frame size from #120, **apply only once the peer's `hello`
  is accepted**. Until then the control channel takes frames of at most 64 KiB and queues at most
  16, and closes with `1009` or `1013` past that. An unauthenticated peer can therefore make a
  teapot hold about 1 MiB per connection, including while `app.upgrade` waits for a slow boot,
  instead of thousands of multi-megabyte frames.

- **Edge HTTP fills `ctx.ip` from `cf-connecting-ip` under `trustProxy`** (#119). `edgeHandler`
  never read the header for HTTP, so IP-keyed plugins such as rate-limit saw `''`, one bucket for
  every client. Under `trustProxy: true` the header now sets `ctx.ip`, and it wins over
  `x-forwarded-for`, because Cloudflare sets it itself while XFF can carry hops the client supplied.
  Without `trustProxy` it is ignored. Only `edgeHandler` reads it: the Node, Deno and Bun adapters, and a
  bare `app.fetch`, ignore it as before.

- **Mesh (alpha): `HEAD` on a remote `GET` route now works** (#125). The teacup resolved `HEAD` to
  the remote `GET` and `OPTIONS` advertised `HEAD`, but the request went to the teapot as `HEAD`,
  which has no `HEAD` plan, so it answered `404`. The teacup now forwards it as a `GET` and drops
  the body, so it answers like a local route: the `GET`'s status and headers, no body, and a
  `404`/`500` from the route keeps its status. An explicit remote `HEAD` route still takes
  precedence. The teapot is unchanged, so a new teacup works against an older teapot during a
  rolling deploy.

- **`static` no longer serves files outside its root through a symlink** (#106). The traversal guard
  compared paths lexically, and the file read then followed symlinks, so `public/leak -> /etc/hosts`
  was served. Containment now compares real paths: the requested file, and a directory's
  `index.html`, must resolve beneath the root's real path. Links that stay inside the root, and a
  root that is itself a symlink, keep working.

  A link that resolves outside the root, or a dangling link, is a **404** — the same miss as a file
  that does not exist, rendered through `onError` like any other, and `405`/`204` where the path has
  routes. It is deliberately not a `403`, so a probe cannot tell "exists outside the root" from
  "does not exist". The content-type still follows the requested name, not the link target.

  The root's real path is resolved on the first request and cached, so **re-pointing a root symlink
  while the app runs needs a restart** to take effect. A link swapped inside the root between the
  check and the read can still escape; exploiting that needs write access to the served directory.

- **A request that fails past the error renderer no longer takes the Node process down** (#108). The Node
  request listener was an `async` function, and `http.createServer` ignores the promise it returns,
  so anything that rejected outside the region where errors convert to a response — a custom static
  resolver, a handler header value Node refuses to write, a stream that fails before its first frame
  — became an unhandled rejection, which Node's default mode turns into an exit. The listener now
  catches it. While the response is still writable the client gets a fixed 500 with
  `connection: close`, written without calling `onError` again; once output has started the socket
  is destroyed instead. Either way the failure is logged through `logger.error`. No `request:end` is
  emitted for these requests. Deno, Bun and the edge were not affected: they receive `app.fetch`'s
  promise, and the runtime answers a rejection with a 500 itself.

- **A malformed WebSocket upgrade no longer takes a Node server down** (#104). The upgrade path never
  ran the request-path normalization HTTP runs, so a bad percent escape in a param segment
  (`/room/%E0%A4%A`) threw out of the `'upgrade'` listener as an uncaught exception, and one request
  was enough to end the process. Upgrades now go through the same normalization: a malformed escape
  or a repeated slash gets a `400`, an unknown route a written `404` instead of a silent disconnect,
  and anything else that throws in the listener a `500`. `//rt//echo` used to match `/rt/echo` on
  upgrade while HTTP refused it; both refuse it now. On Deno, Bun and the edge the same paths close
  with `1008 invalid request path` rather than `1011 internal error`, and on Deno a `1008` sent before
  the socket finished opening now reaches the client instead of leaving it hanging.

- **Deno, Bun and the edge enforce `maxBodyBytes` while reading the body, not after** (#105). The
  fetch adapter read every request through `request.arrayBuffer()` and compared the length once the
  whole body was in memory, so a 10 GB upload was buffered in full before it was refused. It now
  reads `request.body` chunk by chunk, stops at the chunk that crosses the limit and cancels the
  stream, so nothing further is pulled. A `content-length` that already declares more than the limit
  is refused before any of the body is read, on Node too, where the request used to wait for its
  first chunk. A malformed or absent `content-length` proves nothing and is ignored; the running
  count enforces the limit either way. The response is unchanged: the same `413 Payload Too Large`,
  through `onError`, with the same route-over-server precedence for `maxBodyBytes` and `maxParts`.

  workerd may drop `content-length` from a chunked upload, so there an oversized body is refused by
  the count rather than up front. The status is the same; only how early it comes differs.

- **`serveDeno()` and `serveBun()` populate `ctx.ip` with the client's address** (#116). The fetch
  path had no way to learn the socket peer, so every HTTP request on Deno and Bun saw `ctx.ip` as
  `''`, and anything keyed on it put every client in one bucket — the rate-limit plugin, where one
  client could exhaust the limit for everyone, above all. Both adapters now hand the peer to
  `app.fetch`, and `ctx.ip` follows the same rule as Node's `listen()`: the first
  `x-forwarded-for` hop when `trustProxy` is on and the header is present, the socket peer
  otherwise. That includes `trustProxy` with no `x-forwarded-for`, which used to answer `''` on
  the fetch path and now falls back to the peer, as Node always has.

  Addresses are passed through as each runtime reports them, so the IPv6 loopback is `::1` on all
  three but Node may report an IPv4 client as `::ffff:127.0.0.1`. A bare `app.fetch(request)` from
  your own code has no socket to report and still answers `''` (or the forwarded hop), and so does
  a `Request` copied from the one the adapter received. No signature changed. The edge adapter is
  unchanged: trusting `cf-connecting-ip` is only correct behind Cloudflare, and needs its own
  decision.

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
