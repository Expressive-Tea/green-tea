import type http from 'http';
import { Bus, type Events } from '../bus';
import { createDefaultLogger, logRequests, type Logger } from '../logger';
import { Container } from '../container';
import { topoSort, topoLevels, subgraphFor, GraphNode, nearest } from '../graph';
import { toMermaid, toDOT, graphHtml, type GraphView } from '../graph-viz';
import { runPipeline, runSteps, PipelineStep } from '../pipeline';
import { createHttpServer, parseQuery, RouteDef, WsRouteDef, RequestLimits } from '../http';
import type { HttpOptions } from '../http';
import { buildFetch } from '../http/web';
import { matchWsRoute, runWsConnection, trackUntil, type WsRequest, type WsSocket } from '../http/ws-core';
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
import { buildHtmlTransformer, buildStaticResolver, type ViewsContext } from '../views';
import { getArgs, getHandlerNeeds, resolveArgs } from '../params';
import { buildOpenApi, type OpenApiInfo } from '../openapi';
import { connectLink, isPermanentRefusal, type Link } from '../mesh/link';
import { Rooms } from '../rooms';
import type { TlsOptions, SecurityOptions, CorsOptions } from '../security';
import { buildRemote } from '../mesh/teacup';
import { buildManifest, createMeshControl, MESH_CONTROL_PATH } from '../mesh/teapot';
import type { MeshControl } from '../http';
import type { RequestEnvelope, RouteEntry } from '../mesh/protocol';
import type { App, InspectLine, Explain, RoutePlan, MeshConfig } from './types';
import { inspectRoute, buildGraphView, explainRoute } from './introspect';
import { compilePattern } from '../http/router';

export type { App, InspectLine, ExplainNode, Explain, MeshConfig, Hooks } from './types';

type Runner = (ctx: any) => any;

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

/**
 * Build an {@link App} from the given modules and options.
 * Wires providers, steps, controllers and plugins into a dependency graph; for non-mesh apps
 * the graph is finalized eagerly, otherwise finalization is deferred to {@link App.listen}.
 */
export function createApp(opts: {
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
  /** Serve a static directory as a GET/HEAD fallback (after declared routes, before 404). `true` → `./public`. */
  static?: boolean | string;
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
}): App {
  // mesh is alpha: its API and wire protocol may change. Require an explicit opt-in.
  if (opts.mesh && !opts.experimental) {
    throw new Error(
      'mesh is an alpha feature — pass `experimental: true` to createApp to enable it (its API may change between releases)',
    );
  }

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
  let remoteRoutes: RouteDef[] = [];
  const meshLinks: Link[] = [];

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
      const spliced = await spliceRemoteScopes(opts.mesh, bus, registry, logger);
      remoteRoutes = spliced.remoteRoutes;
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

  // Boots exactly once, however first triggered (app.fetch, app.upgrade or listen()); calling
  // several never double-boots (which would re-run provider factories and their side effects).
  const bootApp = makeAppBooter(
    registry,
    opts.overrides,
    () => orderedProviders,
    { runners, container, providerMeta, providerInstances: registry.providerInstances, teardown, bus, logger },
    degradedProviders,
    ready,
  );

  const staticResolver = opts.static ? buildStaticResolver(opts.static) : undefined;

  const fetchOpts: HttpOptions = {
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
  };
  const fetchFn = buildAppFetch(
    routePlans,
    { providedSeed, planSteps, bus, onError: opts.onError, logger },
    fetchOpts,
    bootApp,
    devRoutes,
    () => remoteRoutes,
  );
  const upgradeFn = buildAppUpgrade(routePlans, pipelineDeps, streams, bootApp, () => meshControl);

  const listen = async (port: number): Promise<http.Server> => {
    const deps = pipelineDeps;

    // the same gate app.fetch uses: splices remote mesh scopes, finalizes, boots providers,
    // and builds the mesh control channel — so Node and Deno/Bun serve an identical graph
    await bootApp();

    const httpRoutes = [...buildHttpRoutes(routePlans, remoteRoutes, deps), ...devRoutes()];
    const wsRoutes = buildWsRoutes(routePlans, deps);

    server = createHttpServer(httpRoutes, wsRoutes, bus, meshControl, {
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
    });
    server.on('close', () => closeLinks(meshLinks));
    await new Promise<void>((resolve) => server!.listen(port, resolve));
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

  const close = (options: { timeoutMs?: number } = {}): Promise<void> => {
    clearSignalHandlers();
    return closeApp(
      server,
      meshLinks,
      streams,
      options,
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

  return {
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
    registry.setRunner(meta.provides, (ctx) => instance.provide(ctx));
  }
}

/** Registers a module's `@Step` classes as request-scope step nodes. */
function collectSteps(steps: Ctor[], origin: string, registry: Registry): void {
  for (const StepClass of steps) {
    const meta = getStepMeta(StepClass)!;
    registry.stepNodes.push({ name: meta.provides, needs: meta.needs, provides: [meta.provides], origin });
    if (meta.export) registry.exportedSteps.push(meta.provides);
    const instance: any = new StepClass();
    registry.setRunner(meta.provides, (ctx) => instance.run(ctx));
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
  if (!conflict) return;

  throw new Error(
    `ambiguous route ${candidate.method} ${candidate.pattern} at ${candidate.declaration} conflicts with ` +
      `${conflict.method} ${conflict.pattern} at ${conflict.declaration}`,
  );
}

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

/** Reads every module's metadata into a fresh {@link Registry} of graph nodes, runners and exports. */
function collectModules(modules: Ctor[], viewsCtx: ViewsContext): Registry {
  const registry = emptyRegistry();

  for (const mod of modules) {
    const moduleMeta = getModuleMeta(mod);
    if (!moduleMeta) throw new Error(`${mod.name} is not a @Module`);
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
    registry.setRunner(scopeNode.name, scopeNode.run);
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
  const allowed = new Set<string>([...producedKeys, 'req', 'params', 'query', 'body', 'headers', 'inbound', 'abort']);

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
 * needs an `expects` declaration — see docs/plans/2026-08-18-mesh-degrade-plan.md, still planned.
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

/** Connects the configured teapots, splices their remote steps into the registry, and returns their routes. */
async function spliceRemoteScopes(
  mesh: MeshConfig,
  bus: Bus,
  registry: Registry,
  logger: Logger,
): Promise<{ remoteRoutes: RouteDef[]; meshLinks: Link[]; absent: string[] }> {
  const remoteRoutes: RouteDef[] = [];
  const meshLinks: Link[] = [];
  const absent: string[] = []; // urls of teapots that never connected within the boot budget
  const routeOwners = new Map<string, { url: string; pattern: string }>(); // "METHOD effective-shape" -> owner

  try {
    for (const teapot of mesh.teapots ?? []) {
      warnIfCleartext(teapot.url, logger);
      const link = await connectUntilDeadline(mesh, bus, logger, teapot.url, () =>
        connectLink({
          url: teapot.url,
          secret: teapot.secret,
          timeoutMs: mesh.timeoutMs,
          heartbeatMs: mesh.heartbeatMs,
          reconnect: mesh.reconnect,
          onManifestChange: mesh.onManifestChange,
          logger,
          bus,
        }),
      );

      if (!link) {
        absent.push(teapot.url);
        continue;
      }

      meshLinks.push(link);
      const { steps, routes } = buildRemote(link);
      const origin = `mesh:${teapot.url}`;

      for (const step of steps) {
        registry.stepNodes.push({ name: step.name, needs: [], provides: [step.name], origin });
        registry.setRunner(step.name, step.run);
      }

      for (const route of routes) {
        const display = `${route.method} ${route.pattern}`;
        const key = `${route.method} ${compilePattern(route.pattern).shape}`;
        const owner = routeOwners.get(key);

        // Fail the boot rather than pick one. Route matching keeps the first of two identical
        // patterns, so the loser would be silently dead — and callers could come to depend on
        // "first teapot wins", which would make adding balancing later a breaking change.
        // Scope tokens already fail this way in setRunner; routes now match.
        if (owner) {
          throw new Error(
            `mesh: ambiguous remote route '${display}' from ${teapot.url} conflicts with ` +
              `'${route.method} ${owner.pattern}' from ${owner.url} — ` +
              'load balancing across teapots is not implemented yet, so green-tea will not choose one for you. ' +
              'Export it from a single teapot.',
          );
        }

        routeOwners.set(key, { url: teapot.url, pattern: route.pattern });

        // Local routes are merged ahead of remote ones (see buildHttpRoutes), so a local twin
        // wins. That precedence is deliberate — your own code beats an imported one, and it is
        // how you override a teapot — but silently shadowing an export looks exactly like a
        // broken teapot from the outside. Warn and let the developer decide.
        if (
          registry.routePlans.some(
            (plan) =>
              plan.method === route.method &&
              compilePattern(plan.pattern).shape === compilePattern(route.pattern).shape,
          )
        ) {
          logger.warn(
            `mesh: route '${display}' is exported by teapot ${teapot.url} but also declared locally — ` +
              'the local route takes precedence and the remote one will not be reached. ' +
              'Remove one if that is not what you meant.',
          );
        }

        remoteRoutes.push({
          method: route.method,
          pattern: route.pattern,
          transport: 'buffer',
          // Built explicitly rather than cast from the handler argument. The cast put the whole
          // internal request on the wire — `ip` and `protocol` included — and sent fields the
          // protocol never declared, so a teapot could come to rely on something we never promised.
          handler: async (req) =>
            route.handler({
              method: req.method,
              params: req.params,
              query: req.query,
              body: req.body,
              headers: req.headers,
              url: req.url,
              correlation: { requestId: req.requestId, traceId: req.traceId },
            }),
        });
      }
    }
  } catch (err) {
    closeLinks(meshLinks);
    throw err;
  }

  return { remoteRoutes, meshLinks, absent };
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
 * Builds the mesh control gateway that exposes this node's declared exports over the control channel.
 * Returns undefined when there is nothing to export; throws if exports are declared without a gating secret.
 */
function buildMeshControl(
  mesh: MeshConfig | undefined,
  registry: Registry,
  deps: { container: Container; orderedProviders: GraphNode[]; orderedSteps: GraphNode[]; deps: PipelineDeps },
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

  return createMeshControl({ secret: mesh.secret, manifest, resolveScope, resolveRoute, bus });
}

/** Compiles every non-ws route plan into an HTTP route that seeds and runs the pipeline, plus any remote routes. */
function buildHttpRoutes(routePlans: RoutePlan[], remoteRoutes: RouteDef[], deps: PipelineDeps): RouteDef[] {
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
          seed: {
            ...provided,
            req,
            params: req.params,
            query: req.query,
            body: req.body,
            headers: req.headers,
            protocol: req.protocol,
            ip: req.ip,
          },
        });
      },
    }));

  return [...local, ...remoteRoutes];
}

/**
 * Builds `app.fetch`: a Web-Standards handler over the same route table `listen()` uses, so
 * `Deno.serve(app.fetch)` / `Bun.serve({ fetch: app.fetch })` work without ever calling `listen()`.
 * The boot is awaited *before* the route table is built: for a mesh app the table is not knowable
 * until remote scopes have spliced in, and the boot is what does that. Both are memoized, so this
 * costs one flag check per request after the first.
 */
function buildAppFetch(
  routePlans: RoutePlan[],
  deps: PipelineDeps,
  fetchOpts: HttpOptions,
  ensureBooted: () => Promise<void>,
  devRoutes: () => RouteDef[],
  getRemoteRoutes: () => RouteDef[],
): (request: Request) => Promise<Response> {
  let handler: ((request: Request) => Promise<Response>) | undefined;

  return async (request: Request): Promise<Response> => {
    await ensureBooted(); // idempotent: no-op once any of fetch/upgrade/listen has booted

    if (!handler) {
      handler = buildFetch([...buildHttpRoutes(routePlans, getRemoteRoutes(), deps), ...devRoutes()], fetchOpts);
    }

    return handler(request);
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
): (request: WsRequest, socket: WsSocket) => Promise<void> {
  let wsRoutes: WsRouteDef[] | undefined;

  return async (request: WsRequest, socket: WsSocket): Promise<void> => {
    // Subscribe to inbound BEFORE awaiting the boot. `channel` is fan-out: a frame pushed with no
    // subscriber is dropped, so anything the peer sends while providers are still booting would be
    // lost. For the mesh control channel that is the `hello` itself — the handshake would hang
    // until timeout against a teapot whose providers happened to boot slowly.
    const frames = socket.inbound[Symbol.asyncIterator]();
    const ready: WsSocket = Object.create(socket, {
      inbound: { value: { [Symbol.asyncIterator]: () => frames } },
    }) as WsSocket;

    await ensureBooted(); // idempotent: no-op once any of fetch/upgrade/listen has booted

    const path = request.url.split('?')[0];
    const meshControl = getMeshControl();

    // The reserved mesh path, checked before route matching: this is what lets a teapot export
    // its scopes from Deno/Bun, where the Node `server.on('upgrade')` path does not exist.
    if (path === MESH_CONTROL_PATH) {
      // an explicit refusal, not "no matching ws route": the path is reserved either way, and a
      // peer that reached a teapot with nothing exported deserves to be told which it was
      if (!meshControl) {
        ready.close(1008, 'mesh control channel not enabled: this app exports nothing, or has no mesh.secret');
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

    await runWsConnection(ready, request, route, deps.bus, streams);
  };
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

function closeApp(
  server: http.Server | undefined,
  meshLinks: Link[],
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

      // closeAllConnections() requires Node >=18.2, same floor as closeIdleConnections()
      // below — `engines` in package.json only guarantees >=18, so this matters.
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
function closeLinks(links: Link[]): void {
  for (const link of links) {
    try {
      link.close();
    } catch {
      /* */
    }
  }
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
