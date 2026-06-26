import http from 'http';
import { Bus } from './bus';
import { Container } from './container';
import { topoSort, GraphNode } from './graph';
import { runPipeline, PipelineStep } from './pipeline';
import { createHttpServer, RouteDef } from './http';
import { JsonTransformer } from './transformers';
import { mountPlugin, Plugin, ScopeApi, ScopeNode } from './plugin';
import {
  Ctor, getModuleMeta, getProviderMeta, getStepMeta, getRoutes, getTransformer, joinPath,
} from './metadata';

export interface InspectLine { name: string; kind: 'provider' | 'step' | 'handler'; origin: string }
export interface App {
  listen(port: number): Promise<http.Server>;
  inspect(routePath: string): InspectLine[];
  bus: Bus;
}

interface RoutePlan {
  pattern: string;
  origin: string;
  providers: GraphNode[];
  steps: GraphNode[];
  handlerName: string;
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
        routePlans.push({
          pattern: joinPath(m.mountpoint, route.path),
          origin,
          providers: [],
          steps: [],
          handlerName: route.handlerName,
          run: (ctx) => inst[route.handlerName](ctx),
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

  const inspect = (routePath: string): InspectLine[] => {
    const plan = routePlans.find((p) => p.pattern === routePath);
    if (!plan) throw new Error(`no route: ${routePath}`);
    return [
      ...plan.providers.map((p) => ({ name: p.name, kind: 'provider' as const, origin: p.origin })),
      ...plan.steps.map((s) => ({ name: s.name, kind: 'step' as const, origin: s.origin })),
      { name: plan.handlerName, kind: 'handler' as const, origin: plan.origin },
    ];
  };

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

    const routeDefs: RouteDef[] = routePlans.map((plan) => ({
      method: 'GET',
      pattern: plan.pattern,
      handler: async (req) => {
        // build app-scoped seed by spreading each provider's resolved value into context
        // providers follow the same merge convention as steps: return { token: value }
        const provided: Record<string, unknown> = {};
        for (const p of plan.providers) {
          if (container.has(p.name)) {
            const resolved = (await container.resolve(p.name)) as Record<string, unknown>;
            Object.assign(provided, resolved);
          }
        }
        const steps: PipelineStep[] = plan.steps.map((s) => {
          const fn = runners.get(s.name);
          if (!fn) throw new Error(`no runner registered for step '${s.name}'`);
          return { name: s.name, origin: s.origin, run: fn };
        });
        return runPipeline({
          steps, handler: plan.run, transformer: plan.transformer, bus,
          seed: { ...provided, req, params: req.params },
        });
      },
    }));

    const server = createHttpServer(routeDefs);
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
