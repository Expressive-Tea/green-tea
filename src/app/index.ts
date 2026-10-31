import type http from 'http';
import { Bus, type Events } from '../bus';
import { createDefaultLogger, logRequests, type Logger } from '../logger';
import { Container } from '../container';
import { topoSort, topoLevels, subgraphFor, GraphNode, nearest } from '../graph';
import { toMermaid, toDOT, graphHtml, type GraphView } from '../graph-viz';
import { runPipeline, runSteps, PipelineStep } from '../pipeline';
import { createHttpServer, parseQuery, RouteDef, WsRouteDef, RequestLimits } from '../http';
import type { HttpOptions } from '../http';
import { trustedProxyClient } from '../http/peer';
import { answerFetchProbe, buildFetch } from '../http/web';
import { resolveCompression, edgeMarker, MARK_EDGE, type CompressionOptions } from '../http/compression';
import {
  boundInbound,
  controlBounds,
  validateWsLimits,
  WS_MAX_MESSAGE_BYTES,
  wsMessageBytes,
  matchWsRoute,
  runWsConnection,
  trackUntil,
  type WsRequest,
  type WsSocket,
} from '../http/ws-core';
import { isAsyncIterable } from '../channel';
import { JsonTransformer, type ErrorRenderer } from '../transformers';
import { mountPlugin, Plugin, ScopeApi, ScopeNode } from '../plugin';
import { TeardownRegistry } from '../lifecycle';
import { installSignalHandlers } from '../http/signals-shutdown';
import type { Hooks } from './types';
import {
  Ctor,
  getModuleMeta,
  getProviderMeta,
  getStepMeta,
  getRoutes,
  getTransformer,
  getHtmlMeta,
  joinPath,
  type RouteMeta,
  type TransformerFn,
} from '../metadata';
import { buildHtmlTransformer, buildStaticResolver, normalizeStatic, type ViewsContext } from '../views';
import { getArgs, getHandlerNeeds, resolveArgs } from '../params';
import { buildOpenApi, type OpenApiInfo } from '../openapi';
import { connectLink, isPermanentRefusal, type Link } from '../mesh/link';
import { Rooms } from '../rooms';
import { TLS_REQUESTED, type TlsOptions, type SecurityOptions, type CorsOptions } from '../security';
import { buildRemote, type RemoteRoute as TeacupRemoteRoute } from '../mesh/teacup';
import {
  buildManifest,
  controlFrameLimit,
  createMeshControl,
  MESH_CONTROL_DISABLED_REASON,
  MESH_CONTROL_PATH,
} from '../mesh/teapot';
import type { MeshControl } from '../http';
import type { RequestEnvelope, RouteEntry } from '../mesh/protocol';
import type { App, InspectLine, Explain, RoutePlan, MeshConfig } from './types';
import { inspectRoute, buildGraphView, explainRoute } from './introspect';
import { compilePattern, markRemoteRoute, normalizeRequestPath } from '../http/router';
import { routeConflict, type Precedence, type RouteConflict } from '../http/route-conflicts';
import { assertNotReserved, type ReservedPath } from '../http/reserved-paths';
import { HEALTH_DRAIN, HEALTH_RESERVED, resolveHealth, trackHealth, type HealthConfig } from '../http/health';

export type { App, InspectLine, ExplainNode, Explain, MeshConfig, Hooks } from './types';

type Runner = (ctx: any) => any;

/** Something shutdown closes: a mesh link, or the retry loop of a teapot that missed boot. */
type Closable = Pick<Link, 'close'>;

/** Mutable graph state assembled from modules/plugins and later spliced with remote mesh scopes. */
interface Registry {
  providerNodes: GraphNode[];
  stepNodes: GraphNode[];
  runners: Map<string, Runner>;
  providerMeta: Map<string, { optional: boolean }>;
  /**
   * The `@Provider` instance behind each node, kept only so a `dispose()` can be reached.
   *
   * `collectProviders` used to build the instance and let it live on solely inside the runner's
   * closure, which meant nothing could ever call a method on it again.
   */
  providerInstances: Map<string, { dispose?: () => void | Promise<void> }>;
  routePlans: RoutePlan[];
  exportedSteps: string[];
  exportedRoutes: RouteEntry[];
  setRunner(name: string, runner: Runner, framework?: boolean): void;
}

/**
 * Memoizes an async step so repeat and concurrent callers share one run. Both boot stages need
 * this: `fetch`, `upgrade`, `listen` and `ready` can each be the first to trigger them, and
 * re-running would re-splice a mesh or re-run provider factories and their side effects.
 */
function once(run: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined;

  return (): Promise<void> => {
    if (!promise) promise = run();

    return promise;
  };
}

/** Request-time helpers shared by the HTTP, WS and mesh route builders. */
interface PipelineDeps {
  providedSeed(plan: RoutePlan): Promise<Record<string, unknown>>;
  planSteps(plan: RoutePlan): PipelineStep[];
  bus: Bus;
  onError?: ErrorRenderer;
  /** Where a failing `onError` is reported — the renderer's error is not the request's. */
  logger: Logger;
}

/** Options for {@link createApp}. */
export interface AppOptions {
  modules: Ctor[];
  plugins?: Plugin[];
  /**
   * Lifecycle participation without extending the graph.
   *
   * A plugin means "I want to add nodes"; someone who only needs to close a connection should not
   * have to declare an extension they do not want. Methods are optional so later stages can join
   * without a breaking change — only `onShutdown` exists today.
   */
  hooks?: Hooks[];
  mesh?: MeshConfig;
  limits?: RequestLimits;
  devGraph?: boolean;
  devOpenapi?: boolean;
  /**
   * Serve `GET`/`HEAD` `/__live__` and `/__ready__` for load balancers and orchestrators (default: off).
   *
   * - `/__live__` answers `200 {"status":"ok"}` whenever the process answers.
   * - `/__ready__` answers `503 {"status":"booting"}` until `boot()` resolves, then
   *   `200 {"status":"ok"}` or `200 {"status":"degraded","degraded":[…]}` (see `app.degraded()`),
   *   and `503 {"status":"draining"}` from the moment `close()` starts.
   *
   * Probes skip the pipeline: no step, provider, plugin or `onError` runs and no lifecycle event is
   * emitted, so `logRequests` and metrics plugins never see them. `maxConcurrentRequests` never sheds
   * them. Security headers still apply, plus `cache-control: no-store`; other methods get `405`.
   * While on, a route at either path fails the boot.
   *
   * `drainDelayMs` (default 0) keeps the listener open that long after `close()` starts, with
   * `/__ready__` already answering `503`, before connections drain. Without it Node closes idle
   * keep-alive connections at once, so a probe usually sees a refused connection rather than a `503`.
   * The window is spent out of the shutdown budget (`shutdownTimeoutMs`), not added to it.
   *
   * On the edge there is no `close()`, so `/__ready__` never reports `draining` there.
   */
  health?: boolean | { drainDelayMs?: number };
  overrides?: Record<string, unknown>;
  tls?: TlsOptions;
  trustProxy?: boolean;
  security?: boolean | SecurityOptions;
  cors?: CorsOptions;
  bodyDuplicates?: 'array' | 'last';
  /** Render errors your own way (HTML, custom JSON, …); return a response or undefined to fall back to JSON. */
  onError?: ErrorRenderer;
  /** Base directory `@Html('file.html')` paths resolve against (default: `process.cwd()`). */
  views?: string;
  /** Bring-your-own template engine for `@Html(..., { template: true })`; defaults to the built-in `render`. */
  viewEngine?: (source: string, data: unknown) => string;
  /**
   * Serve a static directory as a GET/HEAD fallback (after declared routes, before 404). `true` →
   * `./public`; a string is the directory; `{ dir?, cacheControl? }` also sets `Cache-Control`.
   *
   * Every hit carries a weak `ETag` and `Last-Modified` from the file's `stat`, and a matching
   * `If-None-Match` (or `If-Modified-Since` when there is no `If-None-Match`) answers `304` without
   * reading the file. `Cache-Control` is `no-cache` unless `cacheControl` says otherwise, so browsers
   * revalidate instead of guessing a lifetime from `Last-Modified`; use
   * `'public, max-age=31536000, immutable'` for content-hashed assets. An unknown key, or a
   * `cacheControl` with CR/LF, throws here. Unavailable on the edge (no filesystem).
   */
  static?: boolean | string | { dir?: string; cacheControl?: string };
  /**
   * Weak ETags for handler responses (default: off). A buffered `200` to GET or HEAD gets
   * `ETag: W/"<length>-<hash>"` computed from its body, and a request whose `If-None-Match` matches
   * gets a bodiless `304`. A handler that sets its own `etag` header keeps it, and that tag drives the
   * comparison. Streams, non-200 responses and other methods are never tagged. The handler still
   * runs: this saves bandwidth, not work. Static files are tagged regardless of this option.
   * Anything but a boolean throws.
   */
  etag?: boolean;
  /**
   * Response compression (default: off). `true`, or `{ threshold?, encodings? }`: `threshold` is
   * the smallest buffered body worth encoding (default `1024` bytes; streams ignore it) and
   * `encodings` the codings core may produce, in preference order (default `['br', 'gzip']`).
   *
   * Negotiated on `Accept-Encoding` (q-values, `identity`, `*`, `q=0`). Text, JSON, JavaScript,
   * ndjson, SVG, XML and wasm are compressed; a response that already has `Content-Encoding` or
   * `Content-Range`, has no `Content-Type`, or says `Cache-Control: no-transform` is left alone.
   * `Vary: Accept-Encoding` is added wherever the choice depended on the request, including every
   * `304`. SSE and ndjson streams are compressed too, flushed after every event.
   *
   * Per runtime:
   * - **Node, Bun:** `node:zlib`, async (off the event loop), br at quality 4.
   * - **Deno:** the same code, but Deno runs `node:zlib`'s async API on the main thread, so core
   *   compression costs event-loop time there — about 4× slower than Node for a 51 KB gzip under
   *   load. Deno's own `automaticCompression` gzip is about 3× faster than core's, but slower for br,
   *   and it weakens strong ETags on what it encodes.
   * - **Edge (Cloudflare Workers):** core never encodes; it sets `Vary` and Cloudflare chooses and
   *   applies the encoding. Detected through `edgeHandler`, or at `createApp` from
   *   `navigator.userAgent`. A bare `export default { fetch: app.fetch }` on a Worker with a compat
   *   date before 2022-03-21 (no `navigator`) is detected only if `node:zlib` fails to load there.
   *
   * ETags (`etag: true`) are taken on the identity body and are weak, so one tag covers every coding.
   * An invalid `threshold` or `encodings` throws.
   */
  compression?: boolean | CompressionOptions;
  /**
   * How long `close()` gives in-flight work before forcing remaining connections shut, in ms
   * (default: 10s). `close({ timeoutMs })` still wins per call. Set it here when `close()` is
   * reached from a signal handler, a test helper or a shutdown hook you do not own, which is
   * where passing it per call is not an option.
   */
  shutdownTimeoutMs?: number;
  /**
   * Milliseconds reserved out of the shutdown budget for teardown, in ms (default: none reserved).
   *
   * Teardown runs after the drain and inside the same `timeoutMs`, so `close()` never takes longer
   * than the caller asked for. Left unset, the drain may use the whole budget and teardown gets
   * whatever remains — possibly nothing. Set it when a connection *must* get its chance to close:
   * the drain is then bounded to `timeoutMs - teardownTimeoutMs` and this slice is guaranteed.
   *
   * Must not exceed `shutdownTimeoutMs`; `createApp` throws rather than clamping silently.
   */
  teardownTimeoutMs?: number;
  /**
   * Register `SIGINT`/`SIGTERM` to run `close()` and exit the process (default: `false`).
   *
   * Off by default because a library that installs process-wide handlers behind your back is worse
   * than one that installs none — when the process exits is the application's call, not ours. Turn
   * it on and the framework absorbs the last runtime difference an app otherwise has: `process.on`
   * on Node and Bun, `Deno.addSignalListener` on Deno, and the matching `exit` for each.
   *
   * Leaving it off is a supported choice, not a gap — write the handler yourself if you want the
   * control. What is *not* optional either way is that something calls `close()`: the teardown
   * registry only runs from there, so a container `SIGKILL`ed after its grace period skips every
   * `dispose()` the registry so carefully ordered, and reports nothing.
   *
   * Registered by `listen()`, `serveDeno()` and `serveBun()`, and taken back off by `close()` —
   * so a *second* signal arriving mid-shutdown falls through to the platform default and ends the
   * process at once. Ctrl-C twice is the way out of a teardown that is stuck; once is the way to
   * let it finish.
   */
  handleSignals?: boolean;
  /**
   * Where every framework diagnostic is written (default: structured JSON, human-readable on a TTY).
   *
   * Registered here rather than declared as a provider, and the ordering is why: provider boot
   * events and the failures they report happen *while* the graph resolves, so a provider cannot
   * report its own boot failing, and shutdown warnings happen after the graph is gone. The logger
   * has to outlive the graph on both ends. It is also reachable from a step or handler as
   * `@needs('logger')` — one object, two access paths.
   */
  logger?: Logger;
  /**
   * Log one line per completed request, and one per failed one (default: off).
   *
   * Off by default because a framework that writes to stdout without being asked is a framework
   * you have to configure before you can use it. On, it is a subscriber to the lifecycle stream
   * like any other consumer — `logRequests(app.bus, app.logger)` does the same thing by hand and
   * hands back an unsubscribe, so nothing here is reachable only through this flag.
   */
  logRequests?: boolean;
  /** Opt in to alpha features whose API may still change. Currently gates `mesh`. */
  experimental?: boolean;
  /**
   * Warn at boot when a route's dependency chain resolves to more than this many steps (default 20;
   * `false` silences). A design nudge, not a perf limit — deep graphs run fine (cost is linear), but
   * 20+ steps on one route usually means a step is doing too much.
   */
  warnGraphDepth?: number | false;
}

/**
 * Build an {@link App} from the given modules and options.
 * Wires providers, steps, controllers and plugins into a dependency graph; for non-mesh apps
 * the graph is finalized eagerly, otherwise finalization is deferred to {@link App.listen}.
 */
export function createApp(opts: AppOptions): App {
  // mesh is alpha: its API and wire protocol may change. Require an explicit opt-in.
  if (opts.mesh && !opts.experimental) {
    throw new Error(
      'mesh is an alpha feature — pass `experimental: true` to createApp to enable it (its API may change between releases)',
    );
  }

  validateWsLimits(opts.limits);
  const health = resolveHealth(opts.health, opts.shutdownTimeoutMs, opts.teardownTimeoutMs);
  assertEtagOption(opts.etag);

  const bus = new Bus();
  const logger = opts.logger ?? createDefaultLogger();
  if (opts.logRequests) logRequests(bus, logger);
  const container = new Container();
  let server: http.Server | undefined;
  const streams = new Set<() => void>();
  const degradedProviders: string[] = []; // optional providers that failed to boot (running degraded)

  // Collect declarations from modules, then splice in plugin- and built-in-provided nodes.
  const viewsCtx: ViewsContext = { views: opts.views, viewEngine: opts.viewEngine };
  const registry = collectModules(opts.modules, viewsCtx);
  const { providerNodes, stepNodes, runners, providerMeta, routePlans } = registry;
  const reserved = reservedPaths(health);
  assertNoReservedRoutes(routePlans, reserved);
  const teardown = buildTeardownRegistry(opts.hooks, opts.teardownTimeoutMs, opts.shutdownTimeoutMs);
  mountPlugins(opts.plugins, bus, registry, teardown);
  provideBuiltins(registry, logger, bus);

  // For each route, resolve which providers/steps feed it via topo order.
  // MVP: every route depends on every declared step + provider in the app graph.
  // For mesh apps, finalize is DEFERRED to the boot gate so remote scopes can join the graph
  // first — connecting to teapots is network I/O, so it cannot happen during construction.
  let orderedProviders: GraphNode[] = [];
  let orderedSteps: GraphNode[] = [];
  let booted = false;
  const meshLinks: Closable[] = [];

  const finalize = (missingNote?: string): void => {
    ({ orderedProviders, orderedSteps } = finalizeGraph(registry, logger, opts.warnGraphDepth, missingNote));
    booted = true;
  };

  if (!opts.mesh) finalize();

  const providedSeed = (plan: RoutePlan) => seedProviders(container, plan);
  const planSteps = (plan: RoutePlan) => compilePlanSteps(runners, plan);
  const pipelineDeps: PipelineDeps = { providedSeed, planSteps, bus, onError: opts.onError, logger };
  let meshControl: MeshControl | undefined;

  // mesh teacup: connect remote teapots and splice their scopes/routes in, then finalize.
  // mesh teapot: build the control channel — it captures the *finalized* ordered nodes, so it
  // can only be built here, after finalize(), and never at construction time.
  const prepareGraph = async (): Promise<void> => {
    if (opts.mesh && !booted) {
      const spliced = await spliceRemoteScopes(opts.mesh, bus, registry, logger, reserved, publishRemote);
      meshLinks.push(...spliced.meshLinks);
      // Without this the error is `missing dependency: auth needed by getUser` and says nothing
      // about the teapot that was away — which is the actual cause every time it is the cause.
      const meshNote = spliced.absent.length
        ? ` — these teapots did not connect, so their exports are absent: ${spliced.absent.join(', ')}`
        : undefined;
      finalize(meshNote);
    }

    meshControl = buildMeshControl(opts.mesh, registry, {
      container,
      orderedProviders,
      orderedSteps,
      deps: pipelineDeps,
      maxBodyBytes: opts.limits?.maxBodyBytes,
    });
  };

  // Memoized separately from the provider boot on purpose: resolving the graph and being ready
  // to serve are different things. Introspection needs only the former, and must not run
  // provider factories (and open their connections) as a side effect of drawing a diagram.
  const ready = once(prepareGraph);

  const inspect = (routePath: string): InspectLine[] => inspectRoute(routePlans, routePath, booted);
  const graph = (): GraphView => buildGraphView(providerNodes, stepNodes, routePlans, booted);
  const explain = (routePath: string): Explain => explainRoute(routePlans, routePath, booted);
  const openapi = (info?: OpenApiInfo) =>
    buildOpenApi(
      routePlans.map((plan) => ({
        method: plan.method,
        pattern: plan.pattern,
        transport: plan.transport,
        args: plan.args,
      })),
      info,
    );

  // Dev-only introspection routes (opt-in). Shared by BOTH listen() and app.fetch so the
  // graph viewer + OpenAPI doc are served on every runtime (Node/Deno/Bun/edge), not Node alone.
  const devRoutes = (): RouteDef[] => {
    const routes: RouteDef[] = [];
    if (opts.devGraph) routes.push(devGraphRoute(graph));
    if (opts.devOpenapi) routes.push(openApiRoute(openapi));
    return routes;
  };

  // The one HTTP route table, shared by app.fetch and listen() — see createRouteTable.
  const table = createRouteTable(() => [...buildHttpRoutes(routePlans, pipelineDeps), ...devRoutes()]);
  const currentTable = table.current;
  const publishRemote = table.publish;

  // Boots exactly once, however first triggered (app.fetch, app.upgrade or listen()); calling
  // several never double-boots (which would re-run provider factories and their side effects).
  const bootGraph = makeAppBooter(
    registry,
    opts.overrides,
    () => orderedProviders,
    { runners, container, providerMeta, providerInstances: registry.providerInstances, teardown, bus, logger },
    degradedProviders,
    ready,
  );

  const { bootApp, healthProbe, drain } = trackHealth(health, bootGraph, () => [...degradedProviders]);

  const staticConfig = normalizeStatic(opts.static);
  const staticResolver = staticConfig ? buildStaticResolver(staticConfig.root, staticConfig.cacheControl) : undefined;

  const compression = resolveCompression(opts.compression);
  const fetchOpts: HttpOptions = {
    compression,
    bus,
    logger,
    limits: opts.limits,
    tls: opts.tls,
    trustProxy: opts.trustProxy,
    security: opts.security ?? true,
    cors: opts.cors,
    bodyDuplicates: opts.bodyDuplicates,
    onError: opts.onError,
    static: staticResolver,
    health: healthProbe,
    etag: opts.etag,
  };
  const fetchFn = buildAppFetch(fetchOpts, bootApp, currentTable);
  // Known at construction, unlike the control channel itself, because `app.upgrade` must bound a
  // socket before it awaits the boot (#120).
  const meshBounds = controlBounds(opts.limits, controlFrameLimit(opts.limits?.maxBodyBytes));
  const upgradeFn = buildAppUpgrade(routePlans, pipelineDeps, streams, bootApp, () => meshControl, {
    limits: opts.limits,
    trustProxy: opts.trustProxy,
    meshBounds,
  });

  const listen = async (port: number): Promise<http.Server> => {
    const deps = pipelineDeps;

    // the same gate app.fetch uses: splices remote mesh scopes, finalizes, boots providers,
    // and builds the mesh control channel — so Node and Deno/Bun serve an identical graph
    await bootApp();

    const wsRoutes = buildWsRoutes(routePlans, deps);

    // A getter, not an array: mesh membership can change the table after this server starts.
    server = createHttpServer(currentTable, wsRoutes, bus, meshControl, {
      compression,
      bus,
      logger,
      limits: opts.limits,
      streams,
      tls: opts.tls,
      trustProxy: opts.trustProxy,
      security: opts.security ?? true,
      cors: opts.cors,
      bodyDuplicates: opts.bodyDuplicates,
      onError: opts.onError,
      static: staticResolver,
      health: healthProbe,
      etag: opts.etag,
    });
    server.on('close', () => closeLinks(meshLinks));
    await bind(server, port).catch((err: unknown) => {
      // Never listened: `close()` treats the app as one that never served, and `listen()` can retry.
      server = undefined;
      throw err;
    });
    // After the socket is up, so a boot that throws never leaves a handler behind pointing at an
    // app that never served.
    handleSignals(close);
    return server;
  };

  // Torn down by whichever close runs first, signal-driven or hand-called. On Deno that is
  // load-bearing rather than tidy: a live `Deno.addSignalListener` keeps the process up, so an app
  // that closed itself and expected to exit would simply hang.
  let removeSignalHandlers: (() => void) | undefined;

  const clearSignalHandlers = (): void => {
    removeSignalHandlers?.();
    removeSignalHandlers = undefined;
  };

  const close = async (options: { timeoutMs?: number } = {}): Promise<void> => {
    clearSignalHandlers();
    // `/__ready__` flips to draining first, and the listener stays open for the drain window.
    const budget = await spendDrainWindow(drain, options, opts.shutdownTimeoutMs, server !== undefined);

    return closeApp(
      server,
      meshLinks,
      streams,
      budget,
      opts.shutdownTimeoutMs,
      logger,
      teardown,
      opts.teardownTimeoutMs,
    );
  };

  const handleSignals = <T extends (options?: { timeoutMs?: number }) => Promise<void>>(closer: T): T => {
    if (!opts.handleSignals) return closer;

    const wrapped = ((options?: { timeoutMs?: number }) => {
      clearSignalHandlers();
      return closer(options);
    }) as T;

    removeSignalHandlers = installSignalHandlers(() => wrapped(), logger);
    return wrapped;
  };

  const app: App = {
    listen,
    close,
    handleSignals,
    ready,
    boot: bootApp,
    fetch: fetchFn,
    upgrade: upgradeFn,
    inspect,
    graph,
    toMermaid: () => toMermaid(graph()),
    toDOT: () => toDOT(graph()),
    explain,
    openapi,
    degraded: () => [...degradedProviders],
    bus,
    logger,
  };

  return Object.assign(app, {
    [WS_MAX_MESSAGE_BYTES]: nativeWsBytes(opts.mesh, registry, opts.limits, meshBounds),
    [HEALTH_DRAIN]: drain,

    // `edgeHandler` calls this: on the edge core never encodes, whatever detection concluded.
    [MARK_EDGE]: edgeMarker(compression),

    // `serveDeno` and `serveBun` refuse an app that asked for TLS only Node's listener can give.
    [TLS_REQUESTED]: Boolean(opts.tls),
  });
}

/** Creates an empty {@link Registry} whose `setRunner` enforces globally-unique provider/step names. */
function emptyRegistry(): Registry {
  const runners = new Map<string, Runner>(); // node name -> runtime fn

  const setRunner = (name: string, runner: Runner, framework = false) => {
    if (!framework && RESERVED_TOKENS.has(name))
      throw new Error(
        `'${name}' is reserved by the framework and cannot be provided by a module, plugin or mesh export — ` +
          `rename it. The framework's own '${name}' is what '@needs' resolves to.`,
      );
    if (runners.has(name))
      throw new Error(`duplicate provider/step name '${name}' — names must be unique across modules and plugins`);
    runners.set(name, runner);
  };

  return {
    providerNodes: [],
    stepNodes: [],
    runners,
    providerMeta: new Map(),
    providerInstances: new Map(),
    routePlans: [],
    exportedSteps: [],
    exportedRoutes: [],
    setRunner,
  };
}

/**
 * Wraps a provider's `provide()` or a step's `run()` so its result is checked against the contract:
 * an object holding every token the node provides. Without this, `return client` instead of
 * `return { db: client }` booted fine. `db` was then `undefined`, and the client's own properties
 * were spread over every request's context. The check stays synchronous for a synchronous node,
 * so a plain step pays a type test rather than an extra microtask on the hot path.
 */
function keyedRunner(kind: string, name: string, provides: readonly string[], run: Runner): Runner {
  const fail = (output: unknown): never => {
    const example = provides.map((token) => `${token}: <value>`).join(', ');
    throw new TypeError(
      `${kind} '${name}' returned ${describeOutput(output)}, but it must return an object holding what it ` +
        `provides: return { ${example} }`,
    );
  };

  // A @Provider or @Step provides one token: test it directly rather than through `every` and its
  // callback, which measured as a 3-4% drop on a 3-step pipeline under Deno and Bun.
  const [only] = provides;
  const check =
    provides.length === 1
      ? (output: unknown): unknown =>
          output !== null && typeof output === 'object' && only! in output ? output : fail(output)
      : (output: unknown): unknown =>
          output !== null && typeof output === 'object' && provides.every((token) => token in output)
            ? output
            : fail(output);

  return (ctx) => {
    const output = run(ctx);
    return output instanceof Promise ? output.then(check) : check(output);
  };
}

function describeOutput(output: unknown): string {
  if (output === null || output === undefined) return String(output);
  if (typeof output !== 'object') return `a ${typeof output}`;
  const keys = Object.keys(output);
  return keys.length
    ? `an object with ${keys
        .slice(0, 5)
        .map((k) => `'${k}'`)
        .join(', ')}`
    : 'an empty object';
}

/** Registers a module's `@Provider` classes as app-scope provider nodes. */
function collectProviders(providers: Ctor[], origin: string, registry: Registry): void {
  for (const ProviderClass of providers) {
    const meta = getProviderMeta(ProviderClass)!;
    registry.providerNodes.push({ name: meta.provides, needs: meta.needs, provides: [meta.provides], origin });
    registry.providerMeta.set(meta.provides, { optional: meta.optional });
    // A provider's value IS the object it builds — a pool, a client, a `db`. That cannot cross a
    // wire, and the half of it that could (plain data) arrived as an app-scope binding the teacup
    // resolved once and cached for the life of the process. A step is the shape that travels:
    // it runs per request, on the teapot, and only its result comes back.
    if (meta.export)
      throw new Error(
        `mesh: provider '${meta.provides}' cannot be exported — a provider is a factory whose value ` +
          'is the object itself, and the mesh transports data, not objects. ' +
          'Export a @Step instead, which runs on the teapot per request and returns its result.',
      );
    const instance: any = new ProviderClass();
    registry.providerInstances.set(meta.provides, instance);
    registry.setRunner(
      meta.provides,
      keyedRunner('provider', meta.provides, [meta.provides], (ctx) => instance.provide(ctx)),
    );
  }
}

/** Registers a module's `@Step` classes as request-scope step nodes. */
function collectSteps(steps: Ctor[], origin: string, registry: Registry): void {
  for (const StepClass of steps) {
    const meta = getStepMeta(StepClass)!;
    registry.stepNodes.push({ name: meta.provides, needs: meta.needs, provides: [meta.provides], origin });
    if (meta.export) registry.exportedSteps.push(meta.provides);
    const instance: any = new StepClass();
    registry.setRunner(
      meta.provides,
      keyedRunner('step', meta.provides, [meta.provides], (ctx) => instance.run(ctx)),
    );
  }
}

/** Registers each `@Route` handler on a module's controllers as a {@link RoutePlan}. */
function collectControllers(
  controllers: Ctor[],
  mountpoint: string,
  origin: string,
  registry: Registry,
  viewsCtx: ViewsContext,
): void {
  for (const ControllerClass of controllers) {
    for (const route of getRoutes(ControllerClass)) {
      const instance: any = new ControllerClass();
      const argSpecs = getArgs(ControllerClass, route.handlerName);
      const pattern = joinPath(mountpoint, route.path);
      const declaration = `${ControllerClass.name}.${route.handlerName}`;

      if (route.export) {
        if (route.transport !== 'buffer') throw new Error(`cannot export streaming route ${pattern}`);
        registry.exportedRoutes.push({ method: route.method, pattern });
      }

      const transformer = resolveTransformer(ControllerClass, route, pattern, viewsCtx);

      const plan: RoutePlan = {
        pattern,
        method: route.method,
        transport: route.transport,
        origin,
        declaration,
        providers: [],
        steps: [],
        handlerName: route.handlerName,
        needs: getHandlerNeeds(argSpecs),
        run: async (context: any) => instance[route.handlerName](...(await resolveArgs(argSpecs, context))),
        transformer,
        duplicates: route.duplicates,
        maxBodyBytes: route.maxBodyBytes,
        maxParts: route.maxParts,
        args: argSpecs,
      };
      assertRouteAvailable(registry.routePlans, plan);
      registry.routePlans.push(plan);
    }
  }
}

/** Rejects local routes that have the same method and effective match shape. */
function assertRouteAvailable(existing: RoutePlan[], candidate: RoutePlan): void {
  const compiled = compilePattern(candidate.pattern);
  const conflict = existing.find(
    (plan) => plan.method === candidate.method && compilePattern(plan.pattern).shape === compiled.shape,
  );

  if (conflict) {
    throw new Error(
      `ambiguous route ${candidate.method} ${candidate.pattern} at ${candidate.declaration} conflicts with ` +
        `${conflict.method} ${conflict.pattern} at ${conflict.declaration}`,
    );
  }

  for (const plan of existing) if (plan.method === candidate.method) assertNoSiblingConflict(plan, candidate);
}

/** The lookup tables a plan is served from. `negotiate` sits in both (see buildHttpRoutes / buildWsRoutes). */
const inHttpTable = (plan: RoutePlan): boolean => plan.transport !== 'ws';
const inWsTable = (plan: RoutePlan): boolean => plan.transport === 'ws' || plan.transport === 'negotiate';

/**
 * Rejects a constrained param that can never be reached, or that ties with a sibling (CARD-13, #127).
 * `earlier` was declared first. Each table is checked under its own precedence: HTTP ranks by
 * specificity, WebSocket takes the first declared match. See `routeConflict` for the definitions.
 */
function assertNoSiblingConflict(earlier: RoutePlan, candidate: RoutePlan): void {
  const tables: Array<[boolean, Precedence]> = [
    [inHttpTable(earlier) && inHttpTable(candidate), 'specificity'],
    [inWsTable(earlier) && inWsTable(candidate), 'registration'],
  ];

  for (const [shared, precedence] of tables) {
    if (!shared) continue;
    const conflict = routeConflict(compilePattern(earlier.pattern), compilePattern(candidate.pattern), precedence);
    if (conflict) throw new Error(localConflictMessage(conflict, [earlier, candidate], precedence));
  }
}

function localConflictMessage(conflict: RouteConflict, plans: [RoutePlan, RoutePlan], precedence: Precedence): string {
  const label = (plan: RoutePlan) =>
    `${plan.transport === 'ws' ? 'WS' : plan.method} ${plan.pattern} at ${plan.declaration}`;
  const ws = precedence === 'registration';

  if (conflict.kind === 'ambiguous') {
    const [earlier, candidate] = plans;
    return (
      `ambiguous route ${label(candidate)} conflicts with ${label(earlier)}: ` +
      `both match ${quoteWitness(conflict.segment)} (${ws ? 'WebSocket' : candidate.method} ${shorten(conflict.path)}), ` +
      'so only declaration order would choose between them — give the constraints disjoint languages, or merge the routes'
    );
  }

  const loser = plans[conflict.loser];
  const winner = plans[1 - conflict.loser];
  const reason = ws
    ? 'WebSocket routes are matched in declaration order, and it is declared first'
    : 'its constraint accepts every segment, and a constrained parameter outranks a plain one';
  return (
    `unreachable route ${label(loser)}: ${label(winner)} matches every request it would, and wins each one — ` +
    `${reason}. Remove one of them, or narrow the constraint`
  );
}

/** Quotes a witness segment for an error message, escaping control characters and eliding long ones. */
function quoteWitness(segment: string): string {
  const shown = JSON.stringify(segment.length > 32 ? segment.slice(0, 32) : segment).slice(1, -1);
  return segment.length > 32 ? `'${shown}…' (${segment.length} characters)` : `'${shown}'`;
}

const shorten = (path: string): string => (path.length > 80 ? `${path.slice(0, 80)}…` : path);

/**
 * Resolves the response transformer for a route: `@Html` metadata builds an HTML transformer (after
 * validating placement — buffered GET/POST only, and not combined with `@Transformer`); otherwise the
 * user's `@Transformer` wins, falling back to {@link JsonTransformer}.
 */
function resolveTransformer(
  ControllerClass: Ctor,
  route: RouteMeta,
  pattern: string,
  viewsCtx: ViewsContext,
): TransformerFn {
  const html = getHtmlMeta(ControllerClass, route.handlerName);
  const userTransformer = getTransformer(ControllerClass, route.handlerName);
  if (!html) return userTransformer ?? JsonTransformer;

  if (route.transport !== 'buffer' || (route.method !== 'GET' && route.method !== 'POST')) {
    throw new Error(
      `@Html on ${route.method} ${pattern} is not allowed — @Html only supports buffered GET/POST routes (not SSE/WS/HEAD/PUT/PATCH/DELETE/OPTIONS)`,
    );
  }

  if (userTransformer) throw new Error(`@Html and @Transformer on ${pattern} conflict — use one`);

  return buildHtmlTransformer(html, viewsCtx);
}

/**
 * Runs the drain window and returns the options `closeApp` should get for what is left.
 *
 * The window comes out of the close budget, so close() still returns within the timeout it was
 * given. Adjusted only when there is a server: without one closeApp only runs teardown, and an
 * explicit timeout there earns a warning the caller never asked for.
 */
async function spendDrainWindow(
  drain: () => Promise<void>,
  options: { timeoutMs?: number },
  shutdownTimeoutMs: number | undefined,
  hasServer: boolean,
): Promise<{ timeoutMs?: number }> {
  const startedAt = Date.now();
  await drain();
  const waited = Date.now() - startedAt;
  if (!hasServer || waited === 0) return options;

  const budget = options.timeoutMs ?? shutdownTimeoutMs ?? 10_000;
  return { timeoutMs: Math.max(0, budget - waited) };
}

/**
 * The paths this app answers itself, ahead of the route table (D17).
 *
 * `/__mesh__/control` is reserved in every app, mesh or not: whether a route there is served must not
 * depend on the runtime or on whether a mesh happens to be configured.
 */
function reservedPaths(health: HealthConfig | undefined): ReservedPath[] {
  const mesh: ReservedPath = { path: MESH_CONTROL_PATH, purpose: 'the mesh control channel' };
  // The probe paths only while health is on: with it off they are ordinary paths (CARD-17 rule 7).
  return health ? [mesh, ...HEALTH_RESERVED] : [mesh];
}

/** Fails the boot when a declared route claims a reserved path (see {@link assertNotReserved}). */
function assertNoReservedRoutes(routePlans: RoutePlan[], reserved: readonly ReservedPath[]): void {
  for (const plan of routePlans) {
    const kind = plan.transport === 'ws' ? '@Ws' : plan.transport === 'negotiate' ? '@Stream' : plan.method;
    assertNotReserved(plan.pattern, `route ${kind} ${plan.pattern} at ${plan.declaration}`, reserved);
  }
}

/** Reads every module's metadata into a fresh {@link Registry} of graph nodes, runners and exports. */
function collectModules(modules: Ctor[], viewsCtx: ViewsContext): Registry {
  const registry = emptyRegistry();

  for (const mod of modules) {
    const moduleMeta = getModuleMeta(mod);
    if (!moduleMeta) throw new Error(`${mod.name} is not a @Module`);
    // `typeof`, not falsiness: `mountpoint: ''` mounts at the root, as it always has.
    if (typeof moduleMeta.mountpoint !== 'string')
      throw new Error(`${mod.name} @Module metadata is missing mountpoint`);
    const origin = `module:${mod.name}`;
    collectProviders(moduleMeta.providers ?? [], origin, registry);
    collectSteps(moduleMeta.steps ?? [], origin, registry);
    collectControllers(moduleMeta.controllers ?? [], moduleMeta.mountpoint, origin, registry, viewsCtx);
  }

  return registry;
}

/**
 * Builds the teardown registry, seeds it with the application's hooks, and validates the reservation.
 *
 * Hooks land before plugins, so the registry running in reverse tears plugins down before the hooks
 * an application registered around them. Both go into the same list: one order, one failure policy.
 */
function buildTeardownRegistry(
  hooks: Hooks[] | undefined,
  teardownTimeoutMs: number | undefined,
  shutdownTimeoutMs: number | undefined,
): TeardownRegistry {
  const budget = shutdownTimeoutMs ?? 10_000;

  // Rejected rather than clamped: a reservation larger than the budget it is carved from is a
  // mistake in the caller's numbers, and quietly shrinking it would hide which of the two they got
  // wrong — at boot, where there is time to fix it, rather than during a shutdown.
  if (teardownTimeoutMs !== undefined && teardownTimeoutMs > budget) {
    throw new Error(
      `teardownTimeoutMs (${teardownTimeoutMs}) cannot exceed shutdownTimeoutMs (${budget}) — ` +
        'it is reserved out of that budget, not added to it',
    );
  }

  const teardown = new TeardownRegistry();
  for (const hook of hooks ?? []) if (hook.onShutdown) teardown.add(hook.onShutdown);
  return teardown;
}

/** Mounts plugins and splices any steps/providers they add into the registry as their own scope. */
function mountPlugins(plugins: Plugin[] | undefined, bus: Bus, registry: Registry, teardown: TeardownRegistry): void {
  const extraSteps: ScopeNode[] = [];
  const scope: ScopeApi = { add: (node) => extraSteps.push(node) };
  // The name is the plugin's identity in `plugin:mounted` and in a mount failure, so two of them
  // make both ambiguous. Two instances of one plugin are legitimate — they differ by `provides`,
  // and the convention derives the name from it (.specs/2026-09-15, rule 2).
  const seen = new Set<string>();

  for (const plugin of plugins ?? []) {
    if (seen.has(plugin.name)) {
      throw new Error(`two plugins are named "${plugin.name}" — pass a different \`provides\` to one of them`);
    }

    seen.add(plugin.name);
    mountPlugin(plugin, bus, scope, (fn) => teardown.add(fn));
  }

  for (const scopeNode of extraSteps) {
    const node = { name: scopeNode.name, needs: scopeNode.needs, provides: scopeNode.provides, origin: 'plugin' };
    if (scopeNode.kind === 'provider') registry.providerNodes.push(node);
    else registry.stepNodes.push(node);
    registry.setRunner(
      scopeNode.name,
      keyedRunner(`plugin ${scopeNode.kind}`, scopeNode.name, scopeNode.provides, scopeNode.run),
    );
  }
}

/** Auto-provides a shared {@link Rooms} instance unless the user already declared a `rooms` provider. */
/**
 * Token names the framework owns. Declaring one is a boot error, not a silent override.
 *
 * Builtins used to be registered with `if (!runners.has(name))`, so a provider called `logger`
 * quietly replaced the framework's own and every `@needs('logger')` in the app got something else.
 * That is the kind of thing that is discovered from a log line that never appeared.
 *
 * `bus` is reserved without being provided, on purpose. It is not a graph token — putting the `Bus`
 * itself in the graph would hand `emit` to every node and turn a one-way observation channel into
 * something anything can forge events on. Reserving the name means `@needs('bus')` can say that,
 * instead of resolving to whatever a user happened to call `bus` and being wrong in silence.
 */
const RESERVED_TOKENS = new Set(['logger', 'rooms', 'events', 'bus']);

function provideBuiltins(registry: Registry, logger: Logger, bus: Bus): void {
  const builtin = (name: string, value: () => Record<string, unknown>): void => {
    registry.providerNodes.push({ name, needs: [], provides: [name], origin: 'builtin' });
    registry.providerMeta.set(name, { optional: false });
    registry.setRunner(name, value, true);
  };

  // `logger` is registered as an ordinary provider *in addition to* being framework infrastructure,
  // so a step or handler reaches it with `@needs('logger')` like any other dependency. It is the
  // same object createApp holds, not a second one — core cannot depend on the graph for something
  // it must use while the graph is still resolving.
  builtin('logger', () => ({ logger }));

  const roomsInstance = new Rooms();
  builtin('rooms', () => ({ rooms: roomsInstance }));

  // The read-only half of the bus, and only the read-only half: `on`, never `emit`. The same
  // narrowing a plugin gets, for the same reason — an observation channel anything can write to is
  // not one.
  //
  // A subscription is not like the other injectables, and the difference is the scope that reaches
  // it. A `@Provider` runs once, so subscribing there is fine; a `@Step` runs *per request*, and a
  // step that calls `on()` registers a listener on every one of them. `on()` returns its own
  // unsubscribe for the provider that wants to clean up in `dispose()` — but a plugin, which gets
  // `on` and `onShutdown` together, remains the right home for observation.
  builtin('events', () => ({ events: { on: bus.on.bind(bus) } satisfies Events }));
}

// Boot-time nudge: a route whose need-closure pulls this many steps is almost always a modeling
// smell (a step doing too much, or work that belongs in a provider), not a real dependency depth.
// Cost is linear so it isn't a perf problem — it's a design one. Generous on purpose.
const DEEP_GRAPH_WARN = 20;

/**
 * Topo-sorts the graph, slices each route's provider/step closure into its plan, and validates every need.
 * @returns The app-scope providers and request-scope steps in execution order.
 */
function finalizeGraph(
  registry: Registry,
  logger: Logger,
  warnDepth: number | false = DEEP_GRAPH_WARN,
  missingNote?: string,
): { orderedProviders: GraphNode[]; orderedSteps: GraphNode[] } {
  const { providerNodes, stepNodes, routePlans } = registry;
  const ordered = topoSort([...providerNodes, ...stepNodes], ['req', 'params'], missingNote);
  const orderedProviders = ordered.filter((node) => providerNodes.includes(node));
  const orderedSteps = ordered.filter((node) => stepNodes.includes(node));
  const alwaysSteps = stepNodes.filter((node) => node.provides.length === 0); // side-effect/observer steps (plugins)
  const alwaysNeeds = alwaysSteps.flatMap((node) => node.needs); // pull observers' deps into every route

  for (const plan of routePlans) {
    const closure = subgraphFor([...plan.needs, ...alwaysNeeds], ordered);
    plan.providers = closure.filter((node) => providerNodes.includes(node));
    const sliced = new Set<GraphNode>([...closure.filter((node) => stepNodes.includes(node)), ...alwaysSteps]);
    plan.steps = ordered.filter((node) => stepNodes.includes(node) && sliced.has(node)); // topo order, deduped

    // The route's own dependency depth, excluding always-on observer steps (plugins).
    const depth = closure.filter((node) => stepNodes.includes(node)).length;

    if (warnDepth !== false && depth > warnDepth) {
      logger.warn(
        `${plan.method} ${plan.pattern} resolves to ${depth} steps — an unusually deep dependency chain. ` +
          `It runs fine (per-request cost is linear), but ${warnDepth}+ steps on one route usually means a step ` +
          `is doing too much or the graph wants splitting. If it's intentional, ignore this.`,
        { route: plan.pattern, method: plan.method, depth, threshold: warnDepth },
      );
    }
  }

  assertNeedsSatisfiable(routePlans, providerNodes, stepNodes, missingNote);
  return { orderedProviders, orderedSteps };
}

/**
 * Throws if any route needs a key that nothing provides, suggesting the nearest match.
 *
 * `missingNote` arrives only from a mesh boot, and only when a teapot did not connect. It changes
 * what the message can honestly claim: "local or connected mesh" instead of "local or mesh", since
 * the exports of an absent teapot were never searched — and it appends which teapots those were,
 * which is the actual cause every time it is the cause.
 */
function assertNeedsSatisfiable(
  routePlans: RoutePlan[],
  providerNodes: GraphNode[],
  stepNodes: GraphNode[],
  missingNote?: string,
): void {
  const producedKeys = new Set<string>([
    ...providerNodes.flatMap((node) => node.provides),
    ...stepNodes.flatMap((node) => node.provides),
  ]);
  const allowed = new Set<string>([
    ...producedKeys,
    'req',
    'params',
    'query',
    'body',
    'headers',
    'cookies',
    'inbound',
    'abort',
  ]);

  for (const plan of routePlans) {
    for (const need of plan.needs) {
      if (allowed.has(need)) continue;

      // The generic message plus a nearest-match is right for a typo and useless here: nothing is
      // spelled nearly enough like `bus` to suggest, and the reader's mistake is not a typo but a
      // reasonable guess about the shape. `@needs('logger')` teaches that framework things are
      // graph tokens, so `@needs('bus')` is the next instinct — and the boot error is the first
      // news that it is not the same shape. Say why, where they are.
      if (need === 'bus') {
        throw new Error(
          `handler '${plan.handlerName}' needs 'bus' — the Bus is not a graph token, because a node ` +
            `that could reach it could also emit, and an observation channel anything can write to ` +
            `is not one. Use @needs('events') for the read-only half ({ on }), or write a plugin, ` +
            `which gets on() and onShutdown() together and is the right home for observation.`,
        );
      }

      const hint = nearest(need, allowed);
      // "local or mesh" claims the mesh was consulted and came up empty — true only when every
      // teapot connected. When one didn't, say "connected mesh" instead so the message doesn't
      // assert a search that never happened, and let missingNote name which teapots were away.
      const scope = missingNote ? 'local or connected mesh' : 'local or mesh';
      throw new Error(
        `handler '${plan.handlerName}' needs '${need}' but nothing (${scope}) provides it` +
          `${hint ? ` — did you mean '${hint}'?` : ''}${missingNote ?? ''}`,
      );
    }
  }
}

/**
 * Keep trying to reach a teapot until `bootTimeoutMs` passes, then give up and fail the boot.
 *
 * The grace exists because "the container is thirty seconds behind" and "the teapot does not
 * exist" look identical for the first thirty seconds, and only one of them should stop a deploy.
 *
 * Each failed attempt is both logged and emitted as `mesh:boot:retry` — logged so an operator
 * watching a deploy sees why it is taking so long, emitted so the wait is visible to whatever
 * collects lifecycle events rather than only to whoever is reading a terminal.
 *
 * Exhausting the budget returns `undefined` rather than throwing (D4 keeps the one exception: a
 * permanent refusal still does). Every export a teapot makes is lazy now — a request-scope step or
 * a proxied route — so nothing needed this link resolved by boot, and a teacup that refuses to
 * start takes down the half of itself that never needed the teapot.
 *
 * Returning `undefined` is not the same as degrading it. The caller registers nothing for a link it
 * never got, because a teapot that did not connect sent no manifest and so nobody knows what it
 * would have exported. Its routes 404 like any unregistered path, and a local node that needs one
 * of its tokens still fails the boot in finalize(), named. Serving 503 for those tokens instead
 * needs an `expects` declaration, which is planned and not built.
 */
async function connectUntilDeadline(
  mesh: MeshConfig,
  bus: Bus,
  logger: Logger,
  url: string,
  attempt: () => Promise<Link>,
): Promise<Link | undefined> {
  const budgetMs = mesh.bootTimeoutMs ?? mesh.timeoutMs ?? 30_000;
  const deadline = Date.now() + budgetMs;
  let delay = 500;
  let attempts = 0;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      attempts += 1;
      const remaining = deadline - Date.now();

      // A refusal is the teapot's decision, not the network's, and it will be the same decision in
      // thirty seconds. Retrying a wrong secret only spends the deploy's patience to reach the
      // identical error, so it fails now.
      if (isPermanentRefusal(error)) {
        logger.error(`mesh: teapot ${url} refused this peer, which retrying cannot fix — ${(error as Error).message}`);
        throw error;
      }

      // The budget is a grace for a co-deploy, not a requirement. Every export is a lazy step or a
      // proxied route now, so nothing needed this link resolved by boot, and a teacup that refuses
      // to start takes down the half of itself that never needed the teapot. What starting does NOT
      // do is degrade the dependency: an absent teapot sent no manifest, so it contributes no nodes
      // at all — its routes 404 and a local `needs` on its tokens still fails in finalize().
      if (remaining <= 0) {
        logger.warn(
          `mesh: teapot ${url} unreachable after ${attempts} attempt(s) over ${budgetMs}ms ` +
            `(${(error as Error).message}) — starting without it. No manifest was ever exchanged, ` +
            `so none of its steps or routes are in this graph: its routes 404 like any path that ` +
            `was never registered, and the boot still fails if anything local needs one of its ` +
            `tokens. This line is what a later 404 on one of its routes points back to.`,
        );
        return undefined;
      }

      bus.emit('mesh:boot:retry', { name: `attempt ${attempts}`, error });
      logger.warn(
        `mesh: teapot ${url} unreachable (${(error as Error).message}) — retrying, ${remaining}ms of boot budget left`,
      );
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, remaining))));
      delay = Math.min(delay * 2, 5_000);
    }
  }
}

/**
 * Warn when a teapot's shared secret would cross a network in cleartext.
 *
 * The `hello` frame carries the secret verbatim, so `ws://` to anywhere but this machine puts it on
 * the wire for anyone in the path to read. Loopback is exempt because there is no path.
 *
 * A warning rather than a refusal: a private network behind a service mesh that already does mutual
 * TLS is a legitimate deployment, and green-tea cannot tell it apart from an exposed one.
 */
function warnIfCleartext(url: string, logger: Logger): void {
  if (!url.startsWith('ws://')) return;
  const host = url.slice('ws://'.length).split('/')[0].split(':')[0];
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return;

  logger.warn(
    `mesh: ${url} is not encrypted, and the shared secret is sent in the handshake — ` +
      'use wss:// unless the link already runs inside an encrypted network.',
  );
}

/** A route a teapot exported, and the teapot it came from. */
interface RemoteRoute {
  method: string;
  pattern: string;
  url: string;
}

/**
 * The same sibling check local routes get (CARD-13, #127), between routes from teapots. They share the
 * remote tree, ranked by specificity. A local route against a remote one is not checked here: the
 * local one wins by design, and a same-shape pair is warned about below.
 */
function assertNoRemoteSiblingConflict(accepted: RemoteRoute[], route: RemoteRoute): void {
  for (const prior of accepted) {
    if (prior.method !== route.method) continue;
    const conflict = routeConflict(compilePattern(prior.pattern), compilePattern(route.pattern), 'specificity');
    if (!conflict) continue;
    const show = (r: RemoteRoute) => `'${r.method} ${r.pattern}' from ${r.url}`;

    if (conflict.kind === 'ambiguous') {
      throw new Error(
        `mesh: ambiguous remote route ${show(route)} conflicts with ${show(prior)}: ` +
          `both match ${quoteWitness(conflict.segment)} (${route.method} ${shorten(conflict.path)}) — ` +
          'green-tea will not choose one for you. Export only one of them, or give their constraints disjoint languages.',
      );
    }

    const [loser, winner] = conflict.loser === 0 ? [prior, route] : [route, prior];
    throw new Error(
      `mesh: unreachable remote route ${show(loser)}: ${show(winner)} matches every request it would, and wins each one — ` +
        'its constraint accepts every segment, and a constrained parameter outranks a plain one. Export only one of them.',
    );
  }
}

/** A teapot route the remote table serves: its export, its owner, and the def the router files. */
interface ServedRemote extends RemoteRoute {
  def: RouteDef;
}

/**
 * The teacup's remote routes, by teapot, published as a fresh array on every change (D15).
 *
 * Never mutated in place: the router caches an index by array identity, and a request that is
 * already routing keeps the array it read, so it sees the whole old table or the whole new one.
 */
interface RemoteTable {
  /**
   * Replaces one teapot's routes and publishes the table. With `strict` (boot) a conflicting route
   * fails the boot; after boot it is refused and logged, and everything else keeps serving.
   */
  set(url: string, routes: TeacupRemoteRoute[], strict: boolean): { added: string[]; removed: string[] };
}

const showRoute = (route: { method: string; pattern: string }): string => `${route.method} ${route.pattern}`;

/**
 * Throws when `route` cannot join the remote routes already accepted: the same effective shape and
 * method as one of them, or a sibling conflict (CARD-13). Route matching keeps the first of two
 * identical patterns, so the loser would be silently dead — and callers could come to depend on
 * "first teapot wins", which would make adding balancing later a breaking change.
 */
function assertRemoteRouteFits(accepted: RemoteRoute[], route: RemoteRoute): void {
  const shape = compilePattern(route.pattern).shape;
  const owner = accepted.find(
    (prior) => prior.method === route.method && compilePattern(prior.pattern).shape === shape,
  );

  if (owner) {
    throw new Error(
      `mesh: ambiguous remote route '${showRoute(route)}' from ${route.url} conflicts with ` +
        `'${showRoute(owner)}' from ${owner.url} — ` +
        'load balancing across teapots is not implemented yet, so green-tea will not choose one for you. ' +
        'Export it from a single teapot.',
    );
  }

  assertNoRemoteSiblingConflict(accepted, route);
}

/**
 * Local routes are merged ahead of remote ones (see the route table), so a local twin wins. That
 * precedence is deliberate — your own code beats an imported one, and it is how you override a
 * teapot — but silently shadowing an export looks exactly like a broken teapot from the outside.
 * Warn and let the developer decide.
 */
function warnIfShadowed(registry: Registry, route: RemoteRoute, logger: Logger): void {
  const shape = compilePattern(route.pattern).shape;
  if (!registry.routePlans.some((plan) => plan.method === route.method && compilePattern(plan.pattern).shape === shape))
    return;

  logger.warn(
    `mesh: route '${showRoute(route)}' is exported by teapot ${route.url} but also declared locally — ` +
      'the local route takes precedence and the remote one will not be reached. ' +
      'Remove one if that is not what you meant.',
  );
}

/** The route the router files for a teapot's export: marked remote, and forwarding a built envelope. */
function remoteRouteDef(route: TeacupRemoteRoute): RouteDef {
  // Marked so the router files it in the remote tree; precedence is unchanged by the split.
  return markRemoteRoute({
    method: route.method,
    pattern: route.pattern,
    transport: 'buffer',
    // Built explicitly rather than cast from the handler argument. The cast put the whole
    // internal request on the wire — `ip` and `protocol` included — and sent fields the
    // protocol never declared, so a teapot could come to rely on something we never promised.
    handler: async (req) =>
      route.handler({
        // HEAD reaches a remote GET through the implicit-HEAD fallback, and the teapot looks
        // its plan up by method, so a forwarded HEAD finds none and answers 404. Send it as the
        // GET it resolved to; dispatch drops the body for HEAD. Fixed teacup-side (D16) so an
        // unchanged, older teapot still answers it during a rolling deploy.
        method: req.method === 'HEAD' && route.method === 'GET' ? 'GET' : req.method,
        params: req.params,
        query: req.query,
        body: req.body,
        headers: req.headers,
        url: req.url,
        correlation: { requestId: req.requestId, traceId: req.traceId },
      }),
  });
}

/** Builds the remote table over the configured teapots, in configuration order. */
function createRemoteTable(
  urls: string[],
  registry: Registry,
  logger: Logger,
  reserved: readonly ReservedPath[],
  publish: (routes: RouteDef[]) => void,
): RemoteTable {
  const byUrl = new Map<string, ServedRemote[]>();

  return {
    set(url, routes, strict) {
      const others = urls.filter((other) => other !== url).flatMap((other) => byUrl.get(other) ?? []);
      const before = new Set((byUrl.get(url) ?? []).map(showRoute));
      const next: ServedRemote[] = [];

      for (const route of routes) {
        const candidate: RemoteRoute = { method: route.method, pattern: route.pattern, url };

        try {
          // A teapot's own boot refuses a reserved path, but the manifest is whatever arrives on the
          // wire: an older or foreign teapot could still advertise one, at boot or later, and the
          // teacup must not splice it (CARD-21/CARD-17).
          assertNotReserved(route.pattern, `mesh: remote route '${showRoute(route)}' from ${url}`, reserved);
          assertRemoteRouteFits([...others, ...next], candidate);
        } catch (error) {
          if (strict) throw error;
          // Refused for this teapot only; the table that is serving stays as it was (D15, rule 5).
          // The same goes for a reserved path: that one route is skipped, the rest are served.
          logger.warn(`mesh: not serving a route from ${url} — ${(error as Error).message}`);
          continue;
        }

        if (!before.has(showRoute(candidate))) warnIfShadowed(registry, candidate, logger);
        next.push({ ...candidate, def: remoteRouteDef(route) });
      }

      byUrl.set(url, next);
      publish(urls.flatMap((other) => (byUrl.get(other) ?? []).map((served) => served.def)));

      const after = new Set(next.map(showRoute));
      return {
        added: [...after].filter((key) => !before.has(key)),
        removed: [...before].filter((key) => !after.has(key)),
      };
    },
  };
}

/** What a teapot's link needs to report membership back to the remote table after boot. */
interface MembershipContext {
  mesh: MeshConfig;
  bus: Bus;
  logger: Logger;
  table: RemoteTable;
}

/** Applies one teapot's routes after boot and emits `mesh:routes` when the table actually changed. */
function applyMembership(ctx: MembershipContext, url: string, routes: TeacupRemoteRoute[]): void {
  const { added, removed } = ctx.table.set(url, routes, false);
  if (!added.length && !removed.length) return;
  ctx.bus.emit('mesh:routes', { name: url, url, added, removed });
}

/**
 * Opens a link to one teapot, wired so a returning manifest updates its routes and a link that
 * gives up for good removes them (D15). `holder.link` is filled in once the link exists, because
 * the callbacks need the link to rebuild its route proxies.
 */
function connectTeapot(
  ctx: MembershipContext,
  teapot: { url: string; secret: string },
  holder: { link?: Link },
): Promise<Link> {
  const { mesh, bus, logger } = ctx;

  return connectLink({
    url: teapot.url,
    secret: teapot.secret,
    timeoutMs: mesh.timeoutMs,
    heartbeatMs: mesh.heartbeatMs,
    reconnect: mesh.reconnect,
    onManifestChange: mesh.onManifestChange,
    logger,
    bus,
    onReconnect: () => {
      if (holder.link) applyMembership(ctx, teapot.url, buildRemote(holder.link).routes);
    },
    onGone: () => {
      logger.warn(`mesh: teapot ${teapot.url} is gone for good — its routes are removed and now answer 404.`);
      applyMembership(ctx, teapot.url, []);
    },
  });
}

/** Backoff bounds for retrying a late teapot: the reconnect ones, or nothing when reconnect is off. */
function lateBounds(mesh: MeshConfig): { initial: number; max: number } | undefined {
  if (mesh.reconnect === false) return undefined;
  const opts = typeof mesh.reconnect === 'object' ? mesh.reconnect : {};
  return { initial: opts.initialDelayMs ?? 500, max: opts.maxDelayMs ?? 30_000 };
}

/**
 * Keeps trying a teapot that missed the boot budget, with the reconnect backoff (D15, rule 1). When
 * it connects, its routes join the remote table; its steps do not, because the graph was validated
 * at boot without them. A permanent refusal stops the retries. The handle's `close()` stops them too,
 * and closes the link if one came up, so shutdown never leaves a retry behind.
 */
function retryLateTeapot(
  ctx: MembershipContext,
  teapot: { url: string; secret: string },
  bounds: { initial: number; max: number },
): { close: () => void } {
  const holder: { link?: Link } = {};
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    const capped = Math.min(bounds.initial * 2 ** attempt++, bounds.max);
    timer = setTimeout(() => void tryOnce(), Math.round(capped / 2 + Math.random() * (capped / 2)));
    timer.unref?.();
  };

  const tryOnce = async (): Promise<void> => {
    try {
      const link = await connectTeapot(ctx, teapot, holder);
      if (stopped) return link.close();
      holder.link = link;
      const { steps, routes } = buildRemote(link);
      if (steps.length)
        ctx.logger.warn(
          `mesh: teapot ${teapot.url} connected after boot — its routes are served now, but its steps ` +
            `(${steps.map((step) => step.name).join(', ')}) are not: the graph was fixed at boot without them.`,
        );
      applyMembership(ctx, teapot.url, routes);
    } catch (error) {
      if (stopped) return;

      if (isPermanentRefusal(error)) {
        ctx.logger.error(
          `mesh: teapot ${teapot.url} refused this peer — no longer retrying it (${(error as Error).message})`,
        );
        return;
      }

      schedule();
    }
  };

  schedule();

  return {
    close: () => {
      stopped = true;
      clearTimeout(timer);
      holder.link?.close();
    },
  };
}

/**
 * Connects the configured teapots, splices their remote steps into the registry, and publishes their
 * routes through `publish`, now and whenever membership changes after boot (D15).
 */
async function spliceRemoteScopes(
  mesh: MeshConfig,
  bus: Bus,
  registry: Registry,
  logger: Logger,
  reserved: readonly ReservedPath[],
  publish: (routes: RouteDef[]) => void,
): Promise<{ meshLinks: Closable[]; absent: string[] }> {
  const meshLinks: Closable[] = [];
  const absent: string[] = []; // urls of teapots that never connected within the boot budget
  const teapots = mesh.teapots ?? [];
  const table = createRemoteTable(
    teapots.map((teapot) => teapot.url),
    registry,
    logger,
    reserved,
    publish,
  );
  const ctx: MembershipContext = { mesh, bus, logger, table };

  try {
    for (const teapot of teapots) {
      warnIfCleartext(teapot.url, logger);
      const holder: { link?: Link } = {};
      const link = await connectUntilDeadline(mesh, bus, logger, teapot.url, () => connectTeapot(ctx, teapot, holder));

      if (!link) {
        absent.push(teapot.url);
        const bounds = lateBounds(mesh);
        if (bounds) meshLinks.push(retryLateTeapot(ctx, teapot, bounds));
        continue;
      }

      holder.link = link;
      meshLinks.push(link);
      const { steps, routes } = buildRemote(link);
      const origin = `mesh:${teapot.url}`;

      for (const step of steps) {
        registry.stepNodes.push({ name: step.name, needs: [], provides: [step.name], origin });
        registry.setRunner(step.name, step.run);
      }

      table.set(teapot.url, routes, true);
    }
  } catch (err) {
    closeLinks(meshLinks);
    throw err;
  }

  return { meshLinks, absent };
}

/** Swaps provider/step runners by token — a value replaces the runner, a function becomes it. */
function applyOverrides(overrides: Record<string, unknown> | undefined, registry: Registry): void {
  if (!overrides) return;
  const produced = new Set([...registry.providerNodes, ...registry.stepNodes].flatMap((node) => node.provides));

  for (const [token, val] of Object.entries(overrides)) {
    if (!produced.has(token)) throw new Error(`override for unknown token '${token}'`);
    const runner: Runner = typeof val === 'function' ? (val as Runner) : () => ({ [token]: val });
    registry.runners.set(token, runner); // direct set (setRunner throws on dup); replaces the real runner
  }
}

/** What a provider's boot produced: nothing to say, or the error it failed with. */
interface BootOutcome {
  node: GraphNode;
  error?: Error;
}

/** Boots one provider and registers its value. Never rejects — the caller decides what a failure means. */
async function bootProvider(
  node: GraphNode,
  deps: { runners: Map<string, Runner>; container: Container; bus: Bus },
): Promise<BootOutcome> {
  const { runners, container, bus } = deps;
  bus.emit('boot:provider:start', { name: node.name, scope: node.origin });

  try {
    const value = await runners.get(node.name)!(await snapshot(container, node.needs));
    container.register(node.name, 'app', () => value);
    await container.resolve(node.name); // warm the cache
    bus.emit('boot:provider:ok', { name: node.name });
    return { node };
  } catch (error) {
    bus.emit('boot:provider:fail', { name: node.name, error });
    return { node, error: error as Error };
  }
}

/**
 * Runs app-scoped providers level by level — concurrently within a level, sequentially between
 * them; required failures abort, optional ones warn.
 *
 * The topo sort already proved nothing in a level can order anything else in it, so serializing a
 * level only ever bought latency: an app paid the sum of its providers' boot times instead of its
 * longest chain. Concurrency is the second thing the graph earns its users, after pruning, and the
 * one a middleware chain structurally cannot offer.
 *
 * @returns The names of optional providers that failed and are running degraded (unregistered).
 */
async function bootProviders(
  orderedProviders: GraphNode[],
  deps: {
    runners: Map<string, Runner>;
    container: Container;
    providerMeta: Map<string, { optional: boolean }>;
    providerInstances: Map<string, { dispose?: () => void | Promise<void> }>;
    teardown: TeardownRegistry;
    bus: Bus;
    logger: Logger;
  },
): Promise<string[]> {
  const { providerMeta, providerInstances, teardown, logger } = deps;
  const degraded: string[] = [];

  for (const level of topoLevels(orderedProviders)) {
    // Outcomes rather than rejections: a sibling that throws must not strand the ones that
    // succeeded, or a provider that opened a pool would never get its dispose() registered.
    const outcomes = await Promise.all(level.map((node) => bootProvider(node, deps)));

    // Teardown in level order, not completion order. `orderedProviders` is topologically sorted and
    // the registry runs in reverse, which is what gives dependants teardown before their
    // dependencies for free — a guarantee that would have become luck if this followed whichever
    // provider happened to settle first. Registered before the failure pass so a level that aborts
    // the boot still leaves its successful siblings closeable.
    //
    // Skipped for a failure on purpose: a provider that threw never provided anything, and calling
    // dispose() on a half-constructed one is how a teardown finds a null connection.
    for (const { node, error } of outcomes) {
      if (error) continue;
      const instance = providerInstances.get(node.name);
      if (instance?.dispose) teardown.add(() => instance.dispose!());
    }

    for (const { node, error } of outcomes) {
      if (!error) continue;

      if (!providerMeta.get(node.name)?.optional) {
        throw new Error(`provider '${node.name}' failed: ${error.message}`);
      }

      // optional: warn, leave it unregistered; routes needing it fail at request time
      // ponytail: full partial-degradation is out of scope (spec §10); warn is enough here
      degraded.push(node.name);
      logger.warn(`optional provider '${node.name}' failed: ${error.message}`, { provider: node.name, error });
    }
  }

  return degraded;
}

/**
 * Returns a memoized boot function: prepares the graph, applies overrides and boots app-scope
 * providers exactly once, however first triggered — `app.fetch`, `app.upgrade` and `listen()` may
 * all call it, and the memoization guarantees only the first runs the sequence. This is the single
 * place an app becomes ready, which is what lets a mesh app boot on any runtime rather than only
 * where `listen()` (a Node http.Server) can be built.
 */
function makeAppBooter(
  registry: Registry,
  overrides: Record<string, unknown> | undefined,
  getOrderedProviders: () => GraphNode[],
  deps: {
    runners: Map<string, Runner>;
    container: Container;
    providerMeta: Map<string, { optional: boolean }>;
    providerInstances: Map<string, { dispose?: () => void | Promise<void> }>;
    teardown: TeardownRegistry;
    bus: Bus;
    logger: Logger;
  },
  degradedProviders: string[],
  /** Resolves the graph (splices remote mesh scopes, finalizes). Must precede providers: remote nodes join the topo sort. */
  prepareGraph: () => Promise<void>,
): () => Promise<void> {
  const runBoot = async (): Promise<void> => {
    await prepareGraph();
    applyOverrides(overrides, registry);
    degradedProviders.length = 0;
    degradedProviders.push(...(await bootProviders(getOrderedProviders(), deps)));

    if (degradedProviders.length) {
      deps.logger.warn(
        `started with ${degradedProviders.length} degraded optional provider(s): ${degradedProviders.join(', ')} — routes that need them will fail at request time.`,
        { degraded: degradedProviders },
      );
    }
  };

  return once(runBoot);
}

/**
 * The one inbound bound Bun applies natively to every socket (`WS_MAX_MESSAGE_BYTES`). A teapot
 * raises it to its control channel's (#120); user routes still close at `maxWsMessageBytes`,
 * because `app.upgrade` bounds them itself.
 */
function nativeWsBytes(
  mesh: MeshConfig | undefined,
  registry: Registry,
  limits: RequestLimits | undefined,
  meshBounds: ReturnType<typeof controlBounds>,
): number {
  const servesControl = mesh?.secret && (registry.exportedSteps.length || registry.exportedRoutes.length);
  return servesControl ? meshBounds.authed.maxWsMessageBytes : wsMessageBytes(limits);
}

/**
 * Builds the mesh control gateway that exposes this node's declared exports over the control channel.
 * Returns undefined when there is nothing to export; throws if exports are declared without a gating secret.
 */
function buildMeshControl(
  mesh: MeshConfig | undefined,
  registry: Registry,
  deps: {
    container: Container;
    orderedProviders: GraphNode[];
    orderedSteps: GraphNode[];
    deps: PipelineDeps;
    maxBodyBytes?: number;
  },
): MeshControl | undefined {
  const { exportedSteps, exportedRoutes, routePlans, runners } = registry;
  const hasExports = exportedSteps.length || exportedRoutes.length;

  if (hasExports && !mesh?.secret) {
    throw new Error('mesh: exports declared (export: true) but no mesh.secret configured to gate the control channel');
  }

  if (!mesh?.secret || !hasExports) return undefined;
  const { container, orderedProviders, orderedSteps } = deps;
  const { bus, providedSeed, planSteps, onError, logger } = deps.deps;
  const manifest = buildManifest({ steps: exportedSteps, routes: exportedRoutes });

  const resolveScope = async (name: string, env: RequestEnvelope): Promise<unknown> => {
    // context is intentionally `any`: providers and steps merge arbitrary keys into it
    const seed: any = { req: env, params: env.params, query: env.query, body: env.body, headers: env.headers };

    for (const provider of orderedProviders)
      if (container.has(provider.name)) Object.assign(seed, await container.resolve(provider.name));

    const steps = orderedSteps.map((step) => ({ name: step.name, origin: step.origin, run: runners.get(step.name)! }));
    // The caller's identity, adopted rather than replaced — the same rule an incoming
    // `x-request-id` gets, applied at the process boundary where it matters most. No `route`:
    // resolving a scope is not a route, and inventing one would put a token in a route label.
    const context = await runSteps(steps, seed, bus, {
      requestId: env.correlation?.requestId,
      traceId: env.correlation?.traceId,
      method: env.method,
    });

    return context[name];
  };

  const resolveRoute = async (name: string, env: RequestEnvelope) => {
    const plan = routePlans.find((candidate) => candidate.pattern === name && candidate.method === env.method);

    if (!plan) {
      const error: any = new Error(`no route ${name}`);
      error.status = 404;
      throw error;
    }

    const provided = await providedSeed(plan);
    const result = await runPipeline({
      steps: planSteps(plan),
      handler: plan.run,
      transformer: plan.transformer,
      bus,
      onError,
      logger,
      transport: plan.transport,
      correlation: {
        requestId: env.correlation?.requestId,
        traceId: env.correlation?.traceId,
        route: plan.pattern,
        method: plan.method,
        transport: plan.transport,
      },
      seed: { ...provided, req: env, params: env.params, query: env.query, body: env.body, headers: env.headers },
    });

    if ('stream' in result) {
      const error: any = new Error('cannot proxy a streaming route');
      error.status = 500;
      throw error;
    }

    return result;
  };

  return createMeshControl({
    secret: mesh.secret,
    manifest,
    resolveScope,
    resolveRoute,
    bus,
    maxBodyBytes: deps.maxBodyBytes,
  });
}

/**
 * The one HTTP route table, shared by app.fetch and listen(): local and dev routes, then remote ones.
 * Built after boot, on first use. A mesh membership change publishes a new array with the same local
 * head (D15), so the router reuses its local trees and rebuilds only the remote ones, and a request in
 * flight keeps the array it read. Dev routes sit before the remote ones so their positions, and with
 * them the local trees, do not move when remote routes come and go.
 */
function createRouteTable(buildLocal: () => RouteDef[]): {
  current: () => RouteDef[];
  publish: (remote: RouteDef[]) => void;
} {
  let remote: RouteDef[] = [];
  let local: RouteDef[] | undefined;
  let table: RouteDef[] | undefined;

  return {
    current: () => {
      if (!table) {
        local = buildLocal();
        table = [...local, ...remote];
      }

      return table;
    },
    publish: (next) => {
      remote = next;
      if (local) table = [...local, ...next];
    },
  };
}

/**
 * The context every HTTP pipeline starts from: what the providers gave, then the request's own keys.
 * `ctx.ip` reads and writes through to `ctx.req.ip`, which resolves on first read. A class so the
 * accessor sits on the prototype: a literal with an accessor is a slow object, and every step and
 * handler read of every key paid for it.
 */
class HttpSeed {
  [key: string]: unknown;
  req: Parameters<RouteDef['handler']>[0];
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  protocol: 'http' | 'https';

  constructor(provided: Record<string, unknown>, req: Parameters<RouteDef['handler']>[0]) {
    Object.assign(this, provided);
    this.req = req;
    this.params = req.params;
    this.query = req.query;
    this.body = req.body;
    this.headers = req.headers;
    this.protocol = req.protocol;
  }

  get ip(): string {
    return this.req.ip;
  }

  set ip(value: string) {
    this.req.ip = value;
  }
}

/** Compiles every non-ws route plan into an HTTP route that seeds and runs the pipeline. */
function buildHttpRoutes(routePlans: RoutePlan[], deps: PipelineDeps): RouteDef[] {
  const { providedSeed, planSteps, bus, onError, logger } = deps;

  const local = routePlans
    .filter((plan) => plan.transport !== 'ws') // buffer | sse | ndjson | negotiate
    .map((plan): RouteDef => ({
      method: plan.method,
      pattern: plan.pattern,
      transport: plan.transport,
      bodyDuplicates: plan.duplicates,
      maxBodyBytes: plan.maxBodyBytes,
      maxParts: plan.maxParts,
      handler: async (req) => {
        const provided = await providedSeed(plan);
        return runPipeline({
          steps: planSteps(plan),
          handler: plan.run,
          transformer: plan.transformer,
          bus,
          onError,
          logger,
          transport: plan.transport,
          // `route` is the pattern, never req.url — a metrics consumer labelling on concrete
          // paths gets one label per distinct URL, and that takes down the metrics backend.
          correlation: {
            requestId: req.requestId,
            traceId: req.traceId,
            route: plan.pattern,
            method: plan.method,
            transport: plan.transport,
          },
          seed: new HttpSeed(provided, req),
        });
      },
    }));

  return local;
}

/**
 * Builds `app.fetch`: a Web-Standards handler over the same route table `listen()` uses, so
 * `Deno.serve(app.fetch)` / `Bun.serve({ fetch: app.fetch })` work without ever calling `listen()`.
 * The boot is awaited *before* the route table is built: for a mesh app the table is not knowable
 * until remote scopes have spliced in, and the boot is what does that. Both are memoized, so this
 * costs one flag check per request after the first.
 */
function buildAppFetch(
  fetchOpts: HttpOptions,
  ensureBooted: () => Promise<void>,
  getRoutes: () => RouteDef[],
): (request: Request) => Promise<Response> {
  let handler: ((request: Request) => Promise<Response>) | undefined;

  // Awaits the boot, then builds the table. Only until the first request has done so: a built table
  // means the boot succeeded, and awaiting a settled boot again costs every request a promise and
  // microtask hops (about 6% of a small request on Deno).
  const firstRequest = async (request: Request): Promise<Response> => {
    await ensureBooted(); // idempotent: no-op once any of fetch/upgrade/listen has booted
    handler ??= buildFetch(getRoutes, fetchOpts);
    return handler(request);
  };

  return async (request: Request): Promise<Response> => {
    // Before the boot, or `/__ready__` could never say `booting`: it would wait for the boot to end.
    // The boot is still started, not awaited: on the edge, or under a bare `Deno.serve(app.fetch)`,
    // nothing else may boot the app, and an orchestrator that waits for ready before sending traffic
    // would wait forever. The rejection is dropped here only; the memo keeps it for real requests.
    const probe = answerFetchProbe(request, fetchOpts);

    if (probe) {
      ensureBooted().catch(() => {});
      return probe;
    }

    return handler ? handler(request) : firstRequest(request);
  };
}

/**
 * Builds `app.upgrade`: the neutral WebSocket entry over the same route table `listen()` uses, so
 * Deno/Bun/edge adapters can drive ws connections without ever calling `listen()`. Node keeps its own
 * `server.on('upgrade')` path (see `attachWs`) and never calls this.
 * Mirrors {@link buildAppFetch}: the boot is awaited before the ws route table is built.
 */
function buildAppUpgrade(
  routePlans: RoutePlan[],
  deps: PipelineDeps,
  streams: Set<() => void>,
  ensureBooted: () => Promise<void>,
  getMeshControl: () => MeshControl | undefined,
  {
    limits,
    trustProxy,
    meshBounds,
  }: {
    limits?: RequestLimits;
    trustProxy?: boolean;
    meshBounds: ReturnType<typeof controlBounds>;
  },
): (request: WsRequest, socket: WsSocket) => Promise<void> {
  let wsRoutes: WsRouteDef[] | undefined;

  return async (request: WsRequest, socket: WsSocket): Promise<void> => {
    // Bound and subscribe to inbound BEFORE awaiting the boot. `channel` is fan-out: a frame pushed
    // with no subscriber is dropped, so anything the peer sends while providers are still booting
    // would be lost. For the mesh control channel that is the `hello` itself — the handshake would
    // hang until timeout against a teapot whose providers happened to boot slowly.
    // The path comes first, though, because it decides the bound: the mesh control channel carries
    // whole request bodies and is bounded by the body limit, not `maxWsMessageBytes` (#120) — once
    // its peer authenticates. Until then, and so throughout the boot, it takes hello-sized frames.
    let path: string;

    // The same normalization HTTP and the Node upgrade listener run. A malformed escape would
    // otherwise reject out of the matcher and close with 1011, a server-error code for a client error.
    try {
      path = normalizeRequestPath(request.url.split('?')[0]);
    } catch {
      socket.close(1008, 'invalid request path');
      return;
    }

    const ready =
      path === MESH_CONTROL_PATH
        ? boundInbound(socket, meshBounds.preAuth, meshBounds.authed)
        : boundInbound(socket, limits);

    await ensureBooted(); // idempotent: no-op once any of fetch/upgrade/listen has booted

    const meshControl = getMeshControl();

    // The reserved mesh path, checked before route matching: this is what lets a teapot export
    // its scopes from Deno/Bun, where the Node `server.on('upgrade')` path does not exist.
    if (path === MESH_CONTROL_PATH) {
      // an explicit refusal, not "no matching ws route": the path is reserved either way, and a
      // peer that reached a teapot with nothing exported deserves to be told which it was
      if (!meshControl) {
        ready.close(1008, MESH_CONTROL_DISABLED_REASON);
        return;
      }

      await trackUntil(ready, meshControl.handle(ready), streams);
      return;
    }

    if (!wsRoutes) wsRoutes = buildWsRoutes(routePlans, deps);

    const route = matchWsRoute(wsRoutes, path);

    if (!route) {
      ready.close(1008, 'no matching ws route');
      return;
    }

    await runWsConnection(ready, withProxyClient(request, trustProxy), route, deps.bus, streams);
  };
}

/**
 * `request` with `ip` taken from the proxy header its adapter recorded, when `trustProxy` allows it
 * (the edge adapter's `cf-connecting-ip`, CARD-23); otherwise `request` unchanged. The same check
 * `app.fetch` runs, so an edge WebSocket upgrade and an edge HTTP request resolve `ctx.ip` alike.
 */
function withProxyClient(request: WsRequest, trustProxy: boolean | undefined): WsRequest {
  const ip = trustedProxyClient(request, trustProxy);
  return ip ? { ...request, ip } : request;
}

/** The dev-only `/__graph__` route: serves the dependency graph as Mermaid text or an HTML viewer. */
function devGraphRoute(graph: () => GraphView): RouteDef {
  return {
    method: 'GET',
    pattern: '/__graph__',
    transport: 'buffer',
    handler: async (req) => {
      const view = graph();
      const accept = String(req.headers['accept'] ?? '');
      return accept.includes('text/plain')
        ? { status: 200, headers: { 'content-type': 'text/plain' }, body: toMermaid(view) }
        : { status: 200, headers: { 'content-type': 'text/html' }, body: graphHtml(view) };
    },
  };
}

/** The dev-only `/__openapi__` route: serves the structural OpenAPI 3.1 document as JSON. */
function openApiRoute(openapi: () => unknown): RouteDef {
  return {
    method: 'GET',
    pattern: '/__openapi__',
    transport: 'buffer',
    handler: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(openapi()),
    }),
  };
}

/** Compiles every ws/negotiate route plan into a WebSocket route that seeds context and runs its steps + handler. */
function buildWsRoutes(routePlans: RoutePlan[], deps: PipelineDeps): WsRouteDef[] {
  const { providedSeed, planSteps, bus } = deps;

  return routePlans
    .filter((plan) => plan.transport === 'ws' || plan.transport === 'negotiate')
    .map((plan) => ({
      pattern: plan.pattern,
      open: async ({ params, inbound, abort, req }) => {
        const provided = await providedSeed(plan);
        // ws upgrades carry the neutral WsRequest (protocol/ip pre-derived by the runtime adapter);
        // trustProxy derivation for ws is out of scope here
        const context = await runSteps(
          planSteps(plan),
          {
            ...provided,
            req,
            params,
            query: parseQuery(req.url ?? ''),
            body: undefined,
            headers: req.headers,
            inbound,
            abort,
            protocol: req.protocol,
            ip: req.ip,
          },
          bus,
        );

        const result = await plan.run(context);
        if (!isAsyncIterable(result)) throw new Error(`@Ws handler '${plan.handlerName}' must return an AsyncIterable`);
        return result as AsyncIterable<unknown>;
      },
    }));
}

/**
 * Runs registered teardown, bounded so it cannot push `close()` past the budget it was given.
 *
 * Bounding lives here rather than in {@link TeardownRegistry} because the registry has no business
 * knowing about deadlines — `closeApp` and `closeWithDeadline` each already own one, and a third
 * implementation is how the three drift into different meanings of the same `timeoutMs`.
 *
 * A teardown that overruns is left running rather than awaited: the callback is someone else's code
 * and there is no way to interrupt it, so the choice is between returning on time and waiting
 * indefinitely. It resolves on its own timer for the same reason `closeWithDeadline` does.
 */
function runTeardown(teardown: TeardownRegistry, logger: Logger, budgetMs: number): Promise<void> {
  if (teardown.size === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let settled = false;

    // Armed before `finish` exists, for the reason spelled out in `closeApp` below: setTimeout
    // cannot fire synchronously, so the forward reference to `finish` rests on a guarantee, while
    // the reverse ordering would rest on `teardown.run().then()` deferring.
    const timer = setTimeout(
      () => {
        if (settled) return;
        logger.warn(`shutdown teardown exceeded its ${Math.max(0, budgetMs)}ms budget — returning without it`, {
          budgetMs: Math.max(0, budgetMs),
        });
        finish();
      },
      Math.max(0, budgetMs),
    );

    timer.unref?.();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    void teardown.run(logger).then(finish, finish);
  });
}

/**
 * `server.listen`, settled either way. A bind failure (`EADDRINUSE`, `EACCES`) arrives as an
 * `error` event, never the listening callback, so without the listener `listen()` would hang
 * and the error would surface as an unhandled one (#138).
 */
function bind(server: http.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeApp(
  server: http.Server | undefined,
  meshLinks: Closable[],
  streams: Set<() => void>,
  options: { timeoutMs?: number },
  defaultTimeoutMs: number | undefined,
  logger: Logger,
  teardown: TeardownRegistry,
  reservedMs: number | undefined,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs ?? 10_000;
  const startedAt = Date.now();
  // Unset reserves nothing: the drain may use the whole budget and teardown takes what is left.
  // Set, it is carved out of the same budget rather than added to it, so `close()` still returns
  // within `timeoutMs` — which is the whole reason the caller set that number.
  const drainBudget = timeoutMs - (reservedMs ?? 0);

  const drain = new Promise<void>((resolve) => {
    // A mesh app booted through `app.fetch` has links but no server, and would leak every
    // teapot connection otherwise — so links close before we even check for a server.
    closeLinks(meshLinks);

    // No server means the app is served through `app.fetch` rather than `listen()`, which is how
    // Deno, Bun and the edge all run. Draining is the transport's job and only the transport holds
    // the handle, so `close()` is deliberately Node-only here rather than pretending otherwise;
    // `serveDeno`/`serveBun` return a server with the same bounded `close({ timeoutMs })`.
    if (!server) {
      if (options.timeoutMs !== undefined) {
        logger.warn(
          'close({ timeoutMs }) does not drain connections here — this app has no listen()ed ' +
            'server, so it only bounds teardown. On Deno and Bun, call close() on the server ' +
            'serveDeno()/serveBun() returned; it takes the same option and drains too. On the ' +
            'edge the platform owns the lifecycle.',
        );
      }

      // Falls through to teardown rather than returning from close(). An app served through
      // `app.fetch` still booted its providers, so it still has connections that were opened and
      // are owed a close — the transport being someone else's job does not make them not ours.
      // Running teardown twice is safe: the registry drains once, whichever entry point is first.
      return resolve();
    }

    let settled = false;

    // The timer is armed before `finish` exists, rather than the other way round, and the ordering
    // is the point. Whichever one comes second is referenced by the other before its declaration
    // runs, so what matters is which forward reference rests on a guarantee. setTimeout cannot
    // invoke its callback synchronously — that is the event loop, not an implementation detail —
    // so `finish` is always assigned by the time the callback can reach it. The reverse ordering
    // relied on `server.close(cb)` deferring, which is Node's behaviour rather than a promise to
    // us, and left a `ReferenceError` waiting in the shutdown path for whoever changed it.
    const timer = setTimeout(() => {
      if (settled) return;

      logger.warn(`graceful shutdown timed out after ${timeoutMs}ms — forcing remaining HTTP connections closed`, {
        timeoutMs,
      });

      // closeAllConnections() and closeIdleConnections() below both arrived in Node 18.2;
      // `engines` guarantees >=22, so both are always present.
      server.closeAllConnections();
      finish();
    }, drainBudget);

    timer.unref?.();

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    server.close(() => finish());

    for (const closeStream of streams) closeStream();
    server.closeIdleConnections();
  });

  // Teardown runs after the drain and before close() resolves: an in-flight request may still be
  // using the connection a teardown is about to close, so draining first is not an ordering
  // preference. It gets whatever is left of the budget — at least the reservation, if one was made.
  return drain.then(() => runTeardown(teardown, logger, timeoutMs - (Date.now() - startedAt)));
}

/** Best-effort close of every mesh link, ignoring individual failures. */
function closeLinks(links: Closable[]): void {
  for (const link of links) {
    try {
      link.close();
    } catch {
      /* */
    }
  }
}

/** `createApp({ etag })` is a boolean or absent; a truthy string doing something would be silent partial behaviour. */
function assertEtagOption(etag: unknown): void {
  if (etag !== undefined && typeof etag !== 'boolean')
    throw new TypeError(`createApp({ etag }): expected a boolean, got ${typeof etag}`);
}

/** Merges every app-scope provider bound to a route into a request seed (skips unresolved providers). */
async function seedProviders(container: Container, plan: RoutePlan): Promise<Record<string, unknown>> {
  const provided: Record<string, unknown> = {};

  for (const provider of plan.providers) {
    if (container.has(provider.name))
      Object.assign(provided, (await container.resolve(provider.name)) as Record<string, unknown>);
  }

  return provided;
}

/** Resolves a route's step nodes into runnable pipeline steps, failing if any runner is missing. */
function compilePlanSteps(runners: Map<string, Runner>, plan: RoutePlan): PipelineStep[] {
  return plan.steps.map((step) => {
    const runner = runners.get(step.name);
    if (!runner) throw new Error(`no runner registered for step '${step.name}'`);
    return { name: step.name, origin: step.origin, run: runner };
  });
}

/** Resolves the given need-keys from the container into a merged snapshot (skips unregistered keys). */
async function snapshot(container: Container, needs: string[]): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};

  for (const key of needs)
    if (container.has(key)) Object.assign(resolved, (await container.resolve(key)) as Record<string, unknown>);

  return resolved;
}
