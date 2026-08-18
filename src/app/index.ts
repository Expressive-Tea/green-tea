import type http from 'http';
import { Bus } from '../bus';
import { createDefaultLogger, logRequests, type Logger } from '../logger';
import { Container } from '../container';
import { topoSort, subgraphFor, GraphNode, nearest } from '../graph';
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
import { connectLink, type Link } from '../mesh/link';
import { Rooms } from '../rooms';
import type { TlsOptions, SecurityOptions, CorsOptions } from '../security';
import { buildRemote } from '../mesh/teacup';
import { buildManifest, createMeshControl, MESH_CONTROL_PATH } from '../mesh/teapot';
import type { MeshControl } from '../http';
import type { RequestEnvelope, RouteEntry } from '../mesh/protocol';
import type { App, InspectLine, Explain, RoutePlan, MeshConfig } from './types';
import { inspectRoute, buildGraphView, explainRoute } from './introspect';
import { compilePattern } from '../http/router';

export type { App, InspectLine, ExplainNode, Explain, MeshConfig } from './types';

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
  exportedProviders: string[];
  exportedSteps: string[];
  exportedRoutes: RouteEntry[];
  setRunner(name: string, runner: Runner): void;
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
  provideBuiltins(registry, logger);

  // For each route, resolve which providers/steps feed it via topo order.
  // MVP: every route depends on every declared step + provider in the app graph.
  // For mesh apps, finalize is DEFERRED to the boot gate so remote scopes can join the graph
  // first — connecting to teapots is network I/O, so it cannot happen during construction.
  let orderedProviders: GraphNode[] = [];
  let orderedSteps: GraphNode[] = [];
  let booted = false;
  let remoteRoutes: RouteDef[] = [];
  const meshLinks: Link[] = [];

  const finalize = (): void => {
    ({ orderedProviders, orderedSteps } = finalizeGraph(registry, logger, opts.warnGraphDepth));
    booted = true;
  };

  if (!opts.mesh) finalize();

  const providedSeed = (plan: RoutePlan) => seedProviders(container, plan);
  const planSteps = (plan: RoutePlan) => compilePlanSteps(runners, plan);
  const pipelineDeps: PipelineDeps = { providedSeed, planSteps, bus, onError: opts.onError };
  let meshControl: MeshControl | undefined;

  // mesh teacup: connect remote teapots and splice their scopes/routes in, then finalize.
  // mesh teapot: build the control channel — it captures the *finalized* ordered nodes, so it
  // can only be built here, after finalize(), and never at construction time.
  const prepareGraph = async (): Promise<void> => {
    if (opts.mesh && !booted) {
      const spliced = await spliceRemoteScopes(opts.mesh, bus, registry, logger, container);
      remoteRoutes = spliced.remoteRoutes;
      meshLinks.push(...spliced.meshLinks);
      finalize();
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
    { providedSeed, planSteps, bus, onError: opts.onError },
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
    return server;
  };

  const close = (options: { timeoutMs?: number } = {}): Promise<void> =>
    closeApp(server, meshLinks, streams, options, opts.shutdownTimeoutMs, logger, teardown, opts.teardownTimeoutMs);

  return {
    listen,
    close,
    ready,
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

  const setRunner = (name: string, runner: Runner) => {
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
    exportedProviders: [],
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
    if (meta.export) registry.exportedProviders.push(meta.provides);
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

  for (const plugin of plugins ?? []) mountPlugin(plugin, bus, scope, (fn) => teardown.add(fn));

  for (const scopeNode of extraSteps) {
    const node = { name: scopeNode.name, needs: scopeNode.needs, provides: scopeNode.provides, origin: 'plugin' };
    if (scopeNode.kind === 'provider') registry.providerNodes.push(node);
    else registry.stepNodes.push(node);
    registry.setRunner(scopeNode.name, scopeNode.run);
  }
}

/** Auto-provides a shared {@link Rooms} instance unless the user already declared a `rooms` provider. */
function provideBuiltins(registry: Registry, logger: Logger): void {
  // `logger` is registered as an ordinary provider *in addition to* being framework infrastructure,
  // so a step or handler reaches it with `@needs('logger')` like any other dependency. It is the
  // same object createApp holds, not a second one — core cannot depend on the graph for something
  // it must use while the graph is still resolving.
  if (!registry.runners.has('logger')) {
    registry.providerNodes.push({ name: 'logger', needs: [], provides: ['logger'], origin: 'builtin' });
    registry.providerMeta.set('logger', { optional: false });
    registry.setRunner('logger', () => ({ logger }));
  }

  if (registry.runners.has('rooms')) return;
  const roomsInstance = new Rooms();
  registry.providerNodes.push({ name: 'rooms', needs: [], provides: ['rooms'], origin: 'builtin' });
  registry.providerMeta.set('rooms', { optional: false });
  registry.setRunner('rooms', () => ({ rooms: roomsInstance })); // merge object -> ctx.rooms
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
): { orderedProviders: GraphNode[]; orderedSteps: GraphNode[] } {
  const { providerNodes, stepNodes, routePlans } = registry;
  const ordered = topoSort([...providerNodes, ...stepNodes], ['req', 'params']);
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

  assertNeedsSatisfiable(routePlans, providerNodes, stepNodes);
  return { orderedProviders, orderedSteps };
}

/** Throws if any route needs a key that nothing (local or mesh) provides, suggesting the nearest match. */
function assertNeedsSatisfiable(routePlans: RoutePlan[], providerNodes: GraphNode[], stepNodes: GraphNode[]): void {
  const producedKeys = new Set<string>([
    ...providerNodes.flatMap((node) => node.provides),
    ...stepNodes.flatMap((node) => node.provides),
  ]);
  const allowed = new Set<string>([...producedKeys, 'req', 'params', 'query', 'body', 'headers', 'inbound', 'abort']);

  for (const plan of routePlans) {
    for (const need of plan.needs) {
      if (allowed.has(need)) continue;
      const hint = nearest(need, allowed);
      throw new Error(
        `handler '${plan.handlerName}' needs '${need}' but nothing (local or mesh) provides it${hint ? ` — did you mean '${hint}'?` : ''}`,
      );
    }
  }
}

/**
 * Re-register a link's app-scope bindings after it reconnects, so their next resolve re-runs the RPC.
 *
 * Named and separate rather than inlined in the reconnect handler: this is the seam a future
 * `onManifestChange: 'reconcile'` reuses, and burying it would mean writing it twice.
 *
 * Lazy on purpose — the RPC runs on the next resolve, not here. Re-resolving eagerly would put a
 * network call on the reconnect path, where a failure has nowhere to go but a swallowed rejection.
 */
function invalidateRemoteBindings(rebind: Array<() => void>): void {
  for (const bind of rebind) bind();
}

/** Connects the configured teapots, splices their remote providers/steps into the registry, and returns their routes. */
async function spliceRemoteScopes(
  mesh: MeshConfig,
  bus: Bus,
  registry: Registry,
  logger: Logger,
  container: Container,
): Promise<{ remoteRoutes: RouteDef[]; meshLinks: Link[] }> {
  const remoteRoutes: RouteDef[] = [];
  const meshLinks: Link[] = [];
  const routeOwners = new Map<string, { url: string; pattern: string }>(); // "METHOD effective-shape" -> owner

  try {
    for (const teapot of mesh.teapots ?? []) {
      // Deferred so the reconnect callback can name this link's provider tokens, which are only
      // known once its manifest arrives — the callback is registered before the link can drop.
      const rebind: Array<() => void> = [];
      const link = await connectLink({
        url: teapot.url,
        secret: teapot.secret,
        timeoutMs: mesh.timeoutMs,
        heartbeatMs: mesh.heartbeatMs,
        reconnect: mesh.reconnect,
        onManifestChange: mesh.onManifestChange,
        onReconnect: () => invalidateRemoteBindings(rebind),
        logger,
        bus,
      });
      meshLinks.push(link);
      const { providers, steps, routes } = buildRemote(link);
      const origin = `mesh:${teapot.url}`;

      for (const provider of providers) {
        registry.providerNodes.push({ name: provider.name, needs: [], provides: [provider.name], origin });
        registry.providerMeta.set(provider.name, { optional: false });
        registry.setRunner(provider.name, provider.run);
        // A remote app-scope value is resolved once at boot and frozen into the container, so it
        // would keep answering from a cache the teapot no longer stands behind. Re-registering
        // gives the binding a factory that re-runs the RPC, and `register` drops the memo with it.
        rebind.push(() => container.register(provider.name, 'app', () => provider.run({})));
      }

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
          handler: async (req) => route.handler(req as RequestEnvelope),
        });
      }
    }
  } catch (err) {
    closeLinks(meshLinks);
    throw err;
  }

  return { remoteRoutes, meshLinks };
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

/**
 * Runs app-scoped providers in topo order, caching each result; required failures abort, optional ones warn.
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
  const { runners, container, providerMeta, providerInstances, teardown, bus, logger } = deps;
  const degraded: string[] = [];

  for (const node of orderedProviders) {
    bus.emit('boot:provider:start', { name: node.name, scope: node.origin });

    try {
      const value = await runners.get(node.name)!(await snapshot(container, node.needs));
      container.register(node.name, 'app', () => value);
      await container.resolve(node.name); // warm the cache
      // Registered here, as it boots, rather than where it was collected. `orderedProviders` is
      // topologically sorted, so registration order *is* boot order — and the registry running in
      // reverse then gives dependants teardown before their dependencies for free, with no second
      // sort to keep in step with this one.
      //
      // Inside the try on purpose: a provider that threw never provided anything, and calling
      // dispose() on a half-constructed one is how a teardown finds a null connection.
      const instance = providerInstances.get(node.name);
      if (instance?.dispose) teardown.add(() => instance.dispose!());
      bus.emit('boot:provider:ok', { name: node.name });
    } catch (error) {
      bus.emit('boot:provider:fail', { name: node.name, error });

      if (!providerMeta.get(node.name)?.optional) {
        throw new Error(`provider '${node.name}' failed: ${(error as Error).message}`);
      }

      // optional: warn, leave it unregistered; routes needing it fail at request time
      // ponytail: full partial-degradation is out of scope (spec §10); warn is enough here
      degraded.push(node.name);
      logger.warn(`optional provider '${node.name}' failed: ${(error as Error).message}`, {
        provider: node.name,
        error,
      });
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
  const { exportedProviders, exportedSteps, exportedRoutes, routePlans, runners } = registry;
  const hasExports = exportedProviders.length || exportedSteps.length || exportedRoutes.length;

  if (hasExports && !mesh?.secret) {
    throw new Error('mesh: exports declared (export: true) but no mesh.secret configured to gate the control channel');
  }

  if (!mesh?.secret || !hasExports) return undefined;
  const { container, orderedProviders, orderedSteps } = deps;
  const { bus, providedSeed, planSteps, onError } = deps.deps;
  const manifest = buildManifest({ providers: exportedProviders, steps: exportedSteps, routes: exportedRoutes });

  const resolveScope = async (name: string, env: RequestEnvelope): Promise<unknown> => {
    // context is intentionally `any`: providers and steps merge arbitrary keys into it
    const seed: any = { req: env, params: env.params, query: env.query, body: env.body, headers: env.headers };

    for (const provider of orderedProviders)
      if (container.has(provider.name)) Object.assign(seed, await container.resolve(provider.name));

    const steps = orderedSteps.map((step) => ({ name: step.name, origin: step.origin, run: runners.get(step.name)! }));
    const context = await runSteps(steps, seed, bus);

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
      transport: plan.transport,
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
  const { providedSeed, planSteps, bus, onError } = deps;

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
