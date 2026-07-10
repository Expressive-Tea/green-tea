import type http from 'http';
import { Bus } from '../bus';
import { Container } from '../container';
import { topoSort, subgraphFor, GraphNode, nearest } from '../graph';
import { toMermaid, toDOT, graphHtml, type GraphView } from '../graph-viz';
import { runPipeline, PipelineStep } from '../pipeline';
import { createHttpServer, parseQuery, RouteDef, WsRouteDef, RequestLimits } from '../http';
import type { HttpOptions } from '../http';
import { buildFetch } from '../http/web';
import { matchWsRoute, runWsConnection, type WsRequest, type WsSocket } from '../http/ws-core';
import { isAsyncIterable } from '../channel';
import { JsonTransformer, type ErrorRenderer } from '../transformers';
import { mountPlugin, Plugin, ScopeApi, ScopeNode } from '../plugin';
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
import { buildManifest, createMeshControl } from '../mesh/teapot';
import type { MeshControl } from '../http';
import type { RequestEnvelope, RouteEntry } from '../mesh/protocol';
import type { App, InspectLine, Explain, RoutePlan, MeshConfig } from './types';
import { inspectRoute, buildGraphView, explainRoute } from './introspect';

export type { App, InspectLine, ExplainNode, Explain, MeshConfig } from './types';

type Runner = (ctx: any) => any;

/** Mutable graph state assembled from modules/plugins and later spliced with remote mesh scopes. */
interface Registry {
  providerNodes: GraphNode[];
  stepNodes: GraphNode[];
  runners: Map<string, Runner>;
  providerMeta: Map<string, { optional: boolean }>;
  routePlans: RoutePlan[];
  exportedProviders: string[];
  exportedSteps: string[];
  exportedRoutes: RouteEntry[];
  setRunner(name: string, runner: Runner): void;
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
  /** Opt in to alpha features whose API may still change. Currently gates `mesh`. */
  experimental?: boolean;
}): App {
  // mesh is alpha: its API and wire protocol may change. Require an explicit opt-in.
  if (opts.mesh && !opts.experimental) {
    throw new Error(
      'mesh is an alpha feature — pass `experimental: true` to createApp to enable it (its API may change between releases)',
    );
  }

  const bus = new Bus();
  const container = new Container();
  let server: http.Server | undefined;
  const streams = new Set<() => void>();
  const degradedProviders: string[] = []; // optional providers that failed to boot (running degraded)

  // Collect declarations from modules, then splice in plugin- and built-in-provided nodes.
  const viewsCtx: ViewsContext = { views: opts.views, viewEngine: opts.viewEngine };
  const registry = collectModules(opts.modules, viewsCtx);
  const { providerNodes, stepNodes, runners, providerMeta, routePlans } = registry;
  mountPlugins(opts.plugins, bus, registry);
  provideBuiltins(registry);

  // For each route, resolve which providers/steps feed it via topo order.
  // MVP: every route depends on every declared step + provider in the app graph.
  // For mesh apps, finalize is DEFERRED to listen() so remote scopes can join the graph first.
  let orderedProviders: GraphNode[] = [];
  let orderedSteps: GraphNode[] = [];
  let booted = false;

  const finalize = (): void => {
    ({ orderedProviders, orderedSteps } = finalizeGraph(registry));
    booted = true;
  };

  if (!opts.mesh) finalize();

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

  const providedSeed = (plan: RoutePlan) => seedProviders(container, plan);
  const planSteps = (plan: RoutePlan) => compilePlanSteps(runners, plan);

  // Boots app-scope providers exactly once, however first triggered (app.fetch or listen()); calling
  // both never double-boots (which would re-run provider factories and their side effects).
  const bootAppProviders = makeProviderBooter(
    registry,
    opts.overrides,
    () => orderedProviders,
    { runners, container, providerMeta, bus },
    degradedProviders,
  );

  const staticResolver = opts.static ? buildStaticResolver(opts.static) : undefined;

  const fetchOpts: HttpOptions = {
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
    () => booted,
    routePlans,
    { providedSeed, planSteps, bus, onError: opts.onError },
    fetchOpts,
    bootAppProviders,
    devRoutes,
  );
  const upgradeFn = buildAppUpgrade(
    () => booted,
    routePlans,
    { providedSeed, planSteps, bus, onError: opts.onError },
    streams,
    bootAppProviders,
  );

  const listen = async (port: number): Promise<http.Server> => {
    const deps: PipelineDeps = { providedSeed, planSteps, bus, onError: opts.onError };

    // mesh teacup: connect remote teapots, splice their scopes/routes into the graph, then finalize
    let remoteRoutes: RouteDef[] = [];
    const meshLinks: Link[] = [];

    if (opts.mesh && !booted) {
      const spliced = await spliceRemoteScopes(opts.mesh, bus, registry);
      remoteRoutes = spliced.remoteRoutes;
      meshLinks.push(...spliced.meshLinks);
      finalize();
    }

    await bootAppProviders();

    const meshControl = buildMeshControl(opts.mesh, registry, {
      container,
      orderedProviders,
      orderedSteps,
      deps,
    });

    const httpRoutes = [...buildHttpRoutes(routePlans, remoteRoutes, deps), ...devRoutes()];
    const wsRoutes = buildWsRoutes(routePlans, deps);

    server = createHttpServer(httpRoutes, wsRoutes, bus, meshControl, {
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

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve()); // waits for in-flight buffered to drain
      for (const closeStream of streams) closeStream(); // force-close long-lived SSE/WS so close() resolves
      server.closeIdleConnections(); // Node >=18.2: drop idle keep-alive
    });

  return {
    listen,
    close,
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

      if (route.export) {
        if (route.transport !== 'buffer') throw new Error(`cannot export streaming route ${pattern}`);
        registry.exportedRoutes.push({ method: route.method, pattern });
      }

      const transformer = resolveTransformer(ControllerClass, route, pattern, viewsCtx);

      registry.routePlans.push({
        pattern,
        method: route.method,
        transport: route.transport,
        origin,
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
      });
    }
  }
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
      `@Html on ${route.method} ${pattern} is not allowed — @Html only supports buffered GET/POST routes (not SSE/WS/PUT/PATCH/DELETE)`,
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

/** Mounts plugins and splices any steps/providers they add into the registry as their own scope. */
function mountPlugins(plugins: Plugin[] | undefined, bus: Bus, registry: Registry): void {
  const extraSteps: ScopeNode[] = [];
  const scope: ScopeApi = { add: (node) => extraSteps.push(node) };

  for (const plugin of plugins ?? []) mountPlugin(plugin, bus, scope);

  for (const scopeNode of extraSteps) {
    const node = { name: scopeNode.name, needs: scopeNode.needs, provides: scopeNode.provides, origin: 'plugin' };
    if (scopeNode.kind === 'provider') registry.providerNodes.push(node);
    else registry.stepNodes.push(node);
    registry.setRunner(scopeNode.name, scopeNode.run);
  }
}

/** Auto-provides a shared {@link Rooms} instance unless the user already declared a `rooms` provider. */
function provideBuiltins(registry: Registry): void {
  if (registry.runners.has('rooms')) return;
  const roomsInstance = new Rooms();
  registry.providerNodes.push({ name: 'rooms', needs: [], provides: ['rooms'], origin: 'builtin' });
  registry.providerMeta.set('rooms', { optional: false });
  registry.setRunner('rooms', () => ({ rooms: roomsInstance })); // merge object -> ctx.rooms
}

/**
 * Topo-sorts the graph, slices each route's provider/step closure into its plan, and validates every need.
 * @returns The app-scope providers and request-scope steps in execution order.
 */
function finalizeGraph(registry: Registry): { orderedProviders: GraphNode[]; orderedSteps: GraphNode[] } {
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

/** Connects the configured teapots, splices their remote providers/steps into the registry, and returns their routes. */
async function spliceRemoteScopes(
  mesh: MeshConfig,
  bus: Bus,
  registry: Registry,
): Promise<{ remoteRoutes: RouteDef[]; meshLinks: Link[] }> {
  const remoteRoutes: RouteDef[] = [];
  const meshLinks: Link[] = [];

  try {
    for (const teapot of mesh.teapots ?? []) {
      const link = await connectLink({ url: teapot.url, secret: teapot.secret, timeoutMs: mesh.timeoutMs, bus });
      meshLinks.push(link);
      const { providers, steps, routes } = buildRemote(link);
      const origin = `mesh:${teapot.url}`;

      for (const provider of providers) {
        registry.providerNodes.push({ name: provider.name, needs: [], provides: [provider.name], origin });
        registry.providerMeta.set(provider.name, { optional: false });
        registry.setRunner(provider.name, provider.run);
      }

      for (const step of steps) {
        registry.stepNodes.push({ name: step.name, needs: [], provides: [step.name], origin });
        registry.setRunner(step.name, step.run);
      }

      for (const route of routes) {
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
    bus: Bus;
  },
): Promise<string[]> {
  const { runners, container, providerMeta, bus } = deps;
  const degraded: string[] = [];

  for (const node of orderedProviders) {
    bus.emit('boot:provider:start', { name: node.name, scope: node.origin });

    try {
      const value = await runners.get(node.name)!(await snapshot(container, node.needs));
      container.register(node.name, 'app', () => value);
      await container.resolve(node.name); // warm the cache
      bus.emit('boot:provider:ok', { name: node.name });
    } catch (error) {
      bus.emit('boot:provider:fail', { name: node.name, error });

      if (!providerMeta.get(node.name)?.optional) {
        throw new Error(`provider '${node.name}' failed: ${(error as Error).message}`);
      }

      // optional: warn, leave it unregistered; routes needing it fail at request time
      // ponytail: full partial-degradation is out of scope (spec §10); warn is enough here
      degraded.push(node.name);
      console.warn(`[green-tea] optional provider '${node.name}' failed: ${(error as Error).message}`);
    }
  }

  return degraded;
}

/**
 * Returns a memoized boot function: applies overrides and boots app-scope providers exactly once,
 * however first triggered — {@link buildAppFetch}'s handler or `listen()` may both call it, and the
 * memoization guarantees only the first call actually runs (and warns about) the boot sequence.
 */
function makeProviderBooter(
  registry: Registry,
  overrides: Record<string, unknown> | undefined,
  getOrderedProviders: () => GraphNode[],
  deps: {
    runners: Map<string, Runner>;
    container: Container;
    providerMeta: Map<string, { optional: boolean }>;
    bus: Bus;
  },
  degradedProviders: string[],
): () => Promise<void> {
  let bootPromise: Promise<void> | undefined;

  const runBoot = async (): Promise<void> => {
    applyOverrides(overrides, registry);
    degradedProviders.length = 0;
    degradedProviders.push(...(await bootProviders(getOrderedProviders(), deps)));

    if (degradedProviders.length) {
      console.warn(
        `[green-tea] started with ${degradedProviders.length} degraded optional provider(s): ${degradedProviders.join(', ')} — routes that need them will fail at request time.`,
      );
    }
  };

  return (): Promise<void> => {
    if (!bootPromise) bootPromise = runBoot();
    return bootPromise;
  };
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
    let context: any = { req: env, params: env.params, query: env.query, body: env.body, headers: env.headers };

    for (const provider of orderedProviders)
      if (container.has(provider.name)) Object.assign(context, await container.resolve(provider.name));

    for (const step of orderedSteps) {
      const runner = runners.get(step.name)!;
      context = { ...context, ...(await runner(context)) };
    }

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
 * Non-mesh apps finalize eagerly, so `getBooted()` is already `true` and the route table is built
 * on the very first call. Mesh apps defer finalize to `listen()` (remote scopes must splice into the
 * graph first): `getBooted` reads the outer `booted` flag *live* on every call — exactly like
 * `explain()`/`graph()`/`inspect()` do — so the returned function throws until `listen()` finalizes,
 * then starts working from the next call on, without ever needing to be rebuilt.
 */
function buildAppFetch(
  getBooted: () => boolean,
  routePlans: RoutePlan[],
  deps: PipelineDeps,
  fetchOpts: HttpOptions,
  ensureBooted: () => Promise<void>,
  devRoutes: () => RouteDef[],
): (request: Request) => Promise<Response> {
  let handler: ((request: Request) => Promise<Response>) | undefined;

  return async (request: Request): Promise<Response> => {
    if (!handler) {
      if (!getBooted()) throw new Error('fetch() unavailable before listen() for mesh apps');
      handler = buildFetch([...buildHttpRoutes(routePlans, [], deps), ...devRoutes()], fetchOpts);
    }

    await ensureBooted(); // idempotent: no-op if listen() already booted the providers
    return handler(request);
  };
}

/**
 * Builds `app.upgrade`: the neutral WebSocket entry over the same route table `listen()` uses, so
 * Deno/Bun/edge adapters can drive ws connections without ever calling `listen()`. Node keeps its own
 * `server.on('upgrade')` path (see `attachWs`) and never calls this.
 * Mirrors {@link buildAppFetch}'s finalize guard exactly: non-mesh apps finalize eagerly, so
 * `getBooted()` is already `true` and the ws route table builds on the first call; mesh apps defer
 * finalize to `listen()`, so this throws until `listen()` finalizes, then works from the next call on.
 */
function buildAppUpgrade(
  getBooted: () => boolean,
  routePlans: RoutePlan[],
  deps: PipelineDeps,
  streams: Set<() => void>,
  ensureBooted: () => Promise<void>,
): (request: WsRequest, socket: WsSocket) => Promise<void> {
  let wsRoutes: WsRouteDef[] | undefined;

  return async (request: WsRequest, socket: WsSocket): Promise<void> => {
    if (!wsRoutes) {
      if (!getBooted()) throw new Error('upgrade() unavailable before listen() for mesh apps');
      wsRoutes = buildWsRoutes(routePlans, deps);
    }

    await ensureBooted(); // idempotent: no-op if listen() already booted the providers
    const path = request.url.split('?')[0];
    const route = matchWsRoute(wsRoutes, path);

    if (!route) {
      socket.close(1008, 'no matching ws route');
      return;
    }

    await runWsConnection(socket, request, route, deps.bus, streams);
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
  const { providedSeed, planSteps } = deps;

  return routePlans
    .filter((plan) => plan.transport === 'ws' || plan.transport === 'negotiate')
    .map((plan) => ({
      pattern: plan.pattern,
      open: async ({ params, inbound, abort, req }) => {
        const provided = await providedSeed(plan);
        // ws upgrades carry the neutral WsRequest (protocol/ip pre-derived by the runtime adapter);
        // trustProxy derivation for ws is out of scope here
        // context is intentionally `any`: each step merges arbitrary keys into it
        let context: any = {
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
        };

        for (const step of planSteps(plan)) {
          context = { ...context, ...(await step.run(context)) };
        }

        const result = await plan.run(context);
        if (!isAsyncIterable(result)) throw new Error(`@Ws handler '${plan.handlerName}' must return an AsyncIterable`);
        return result as AsyncIterable<unknown>;
      },
    }));
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
