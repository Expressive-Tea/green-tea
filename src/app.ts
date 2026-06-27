import http from 'http';
import { Bus } from './bus';
import { Container } from './container';
import { topoSort, GraphNode } from './graph';
import { runPipeline, PipelineStep } from './pipeline';
import { createHttpServer, parseQuery, RouteDef, WsRouteDef } from './http';
import { isAsyncIterable } from './channel';
import { JsonTransformer } from './transformers';
import { mountPlugin, Plugin, ScopeApi, ScopeNode } from './plugin';
import {
  Ctor, HttpMethod, Transport, getModuleMeta, getProviderMeta, getStepMeta, getRoutes, getTransformer, joinPath,
} from './metadata';
import { getArgs, getHandlerNeeds, resolveArgs } from './params';

export interface InspectLine { name: string; kind: 'provider' | 'step' | 'handler'; origin: string }
export interface App {
  listen(port: number): Promise<http.Server>;
  inspect(routePath: string): InspectLine[];
  bus: Bus;
}

interface RoutePlan {
  pattern: string;
  method: HttpMethod;
  transport: Transport;
  origin: string;
  providers: GraphNode[];
  steps: GraphNode[];
  handlerName: string;
  needs: string[];
  run: (ctx: any) => unknown;
  transformer: typeof JsonTransformer;
}

export function createApp(opts: { modules: Ctor[]; plugins?: Plugin[] }): App {
  const bus = new Bus();
  const container = new Container();
  const extraSteps: ScopeNode[] = [];
  const scope: ScopeApi = { add: (n) => extraSteps.push(n) };

  // collect declarations from modules
  const providerNodes: GraphNode[] = [];
  const stepNodes: GraphNode[] = [];
  const runners = new Map<string, (ctx: any) => any>();      // node name -> runtime fn
  const setRunner = (name: string, fn: (ctx: any) => any) => {
    if (runners.has(name)) throw new Error(`duplicate provider/step name '${name}' — names must be unique across modules and plugins`);
    runners.set(name, fn);
  };
  const providerMeta = new Map<string, { optional: boolean }>();
  const routePlans: RoutePlan[] = [];

  for (const mod of opts.modules) {
    const m = getModuleMeta(mod);
    if (!m) throw new Error(`${mod.name} is not a @Module`);
    const origin = `module:${mod.name}`;

    for (const P of m.providers ?? []) {
      const meta = getProviderMeta(P)!;
      providerNodes.push({ name: meta.provides, needs: meta.needs, provides: [meta.provides], origin });
      providerMeta.set(meta.provides, { optional: meta.optional });
      const inst: any = new P();
      setRunner(meta.provides, (ctx) => inst.provide(ctx));
    }
    for (const S of m.steps ?? []) {
      const meta = getStepMeta(S)!;
      stepNodes.push({ name: meta.provides, needs: meta.needs, provides: [meta.provides], origin });
      const inst: any = new S();
      setRunner(meta.provides, (ctx) => inst.run(ctx));
    }
    for (const C of m.controllers ?? []) {
      for (const route of getRoutes(C)) {
        const inst: any = new C();
        const argSpecs = getArgs(C, route.handlerName);
        routePlans.push({
          pattern: joinPath(m.mountpoint, route.path),
          method: route.method,
          transport: route.transport,
          origin,
          providers: [],
          steps: [],
          handlerName: route.handlerName,
          needs: getHandlerNeeds(argSpecs),
          run: (c: any) => inst[route.handlerName](...resolveArgs(argSpecs, c)),
          transformer: getTransformer(C, route.handlerName) ?? JsonTransformer,
        });
      }
    }
  }

  // plugin-added steps join the graph as their own scope
  for (const plugin of opts.plugins ?? []) mountPlugin(plugin, bus, scope);
  for (const n of extraSteps) {
    const node = { name: n.name, needs: n.needs, provides: n.provides, origin: 'plugin' };
    if (n.kind === 'provider') providerNodes.push(node); else stepNodes.push(node);
    setRunner(n.name, n.run);
  }

  // For each route, resolve which providers/steps feed it via topo order.
  // MVP: every route depends on every declared step + provider in the app graph.
  const seedKeys = ['req', 'params'];
  const ordered = topoSort([...providerNodes, ...stepNodes], seedKeys);
  const orderedProviders = ordered.filter((n) => providerNodes.includes(n));
  const orderedSteps = ordered.filter((n) => stepNodes.includes(n));
  for (const plan of routePlans) { plan.providers = orderedProviders; plan.steps = orderedSteps; }

  const producedKeys = new Set<string>([
    ...providerNodes.flatMap((n) => n.provides),
    ...stepNodes.flatMap((n) => n.provides),
  ]);
  const allowed = new Set<string>([...producedKeys, 'req', 'params', 'query', 'body', 'headers', 'inbound', 'abort']);
  for (const plan of routePlans) {
    for (const need of plan.needs) {
      if (!allowed.has(need)) {
        throw new Error(`handler '${plan.handlerName}' needs '${need}' but nothing provides it`);
      }
    }
  }

  const inspect = (routePath: string): InspectLine[] => {
    const plan = routePlans.find((p) => p.pattern === routePath);
    if (!plan) throw new Error(`no route: ${routePath}`);
    return [
      ...plan.providers.map((p) => ({ name: p.name, kind: 'provider' as const, origin: p.origin })),
      ...plan.steps.map((s) => ({ name: s.name, kind: 'step' as const, origin: s.origin })),
      { name: plan.handlerName, kind: 'handler' as const, origin: plan.origin },
    ];
  };

  const providedSeed = async (plan: RoutePlan): Promise<Record<string, unknown>> => {
    const provided: Record<string, unknown> = {};
    for (const p of plan.providers) {
      if (container.has(p.name)) Object.assign(provided, (await container.resolve(p.name)) as Record<string, unknown>);
    }
    return provided;
  };
  const planSteps = (plan: RoutePlan): PipelineStep[] => plan.steps.map((s) => {
    const fn = runners.get(s.name);
    if (!fn) throw new Error(`no runner registered for step '${s.name}'`);
    return { name: s.name, origin: s.origin, run: fn };
  });

  const listen = async (port: number): Promise<http.Server> => {
    // run app-scoped providers in order (fail-fast for required)
    for (const node of orderedProviders) {
      bus.emit('boot:provider:start', { name: node.name, scope: node.origin });
      try {
        const value = await runners.get(node.name)!(await snapshot(container, node.needs));
        container.register(node.name, 'app', () => value);
        await container.resolve(node.name);                // warm the cache
        bus.emit('boot:provider:ok', { name: node.name });
      } catch (error) {
        bus.emit('boot:provider:fail', { name: node.name, error });
        if (!providerMeta.get(node.name)?.optional) {
          throw new Error(`provider '${node.name}' failed: ${(error as Error).message}`);
        }
        // optional: warn, leave it unregistered; routes needing it fail at request time
        // ponytail: full partial-degradation is out of scope (spec §10); warn is enough here
        console.warn(`[green-tea] optional provider '${node.name}' failed: ${(error as Error).message}`);
      }
    }

    const httpRoutes: RouteDef[] = routePlans
      .filter((plan) => plan.transport !== 'ws')   // buffer | sse | ndjson | negotiate
      .map((plan) => ({
        method: plan.method, pattern: plan.pattern, transport: plan.transport,
        handler: async (req) => {
          const provided = await providedSeed(plan);
          return runPipeline({
            steps: planSteps(plan), handler: plan.run, transformer: plan.transformer, bus,
            seed: { ...provided, req, params: req.params, query: req.query, body: req.body, headers: req.headers },
          });
        },
      }));

    const wsRoutes: WsRouteDef[] = routePlans
      .filter((plan) => plan.transport === 'ws' || plan.transport === 'negotiate')
      .map((plan) => ({
        pattern: plan.pattern,
        open: async ({ params, inbound, abort, req }) => {
          const provided = await providedSeed(plan);
          let ctx: any = { ...provided, req, params, query: parseQuery(req.url ?? ''), body: undefined,
                           headers: req.headers, inbound, abort };
          for (const s of planSteps(plan)) { ctx = { ...ctx, ...(await s.run(ctx)) }; }
          const out = plan.run(ctx);
          if (!isAsyncIterable(out)) throw new Error(`@Ws handler '${plan.handlerName}' must return an AsyncIterable`);
          return out as AsyncIterable<unknown>;
        },
      }));

    const server = createHttpServer(httpRoutes, wsRoutes, bus);
    await new Promise<void>((resolve) => server.listen(port, resolve));
    return server;
  };

  return { listen, inspect, bus };
}

async function snapshot(c: Container, needs: string[]): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of needs) if (c.has(key)) Object.assign(out, (await c.resolve(key)) as Record<string, unknown>);
  return out;
}
