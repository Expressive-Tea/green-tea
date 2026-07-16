import type { GraphNode } from '../graph';
import type { GraphView } from '../graph-viz';
import type { InspectLine, Explain, ExplainNode, RoutePlan } from './types';

/** Lists the provider/step/handler chain for a route, in execution order. */
export function inspectRoute(routePlans: RoutePlan[], routePath: string, booted: boolean): InspectLine[] {
  if (!booted)
    throw new Error(
      'inspect() unavailable until a mesh app has booted: a mesh graph is not knowable until its teapots are asked. Call `await app.ready()` first — it is a no-op on a non-mesh app',
    );
  const plan = routePlans.find((candidate) => candidate.pattern === routePath);
  if (!plan) throw new Error(`no route: ${routePath}`);
  return [
    ...plan.providers.map((provider) => ({
      name: provider.name,
      kind: 'provider' as const,
      origin: provider.origin,
    })),
    ...plan.steps.map((step) => ({ name: step.name, kind: 'step' as const, origin: step.origin })),
    { name: plan.handlerName, kind: 'handler' as const, origin: plan.origin },
  ];
}

/** Builds the full dependency-graph view: every provider/step node plus each route's chain. */
export function buildGraphView(
  providerNodes: GraphNode[],
  stepNodes: GraphNode[],
  routePlans: RoutePlan[],
  booted: boolean,
): GraphView {
  if (!booted)
    throw new Error(
      'graph() unavailable until a mesh app has booted: a mesh graph is not knowable until its teapots are asked. Call `await app.ready()` first — it is a no-op on a non-mesh app',
    );
  return {
    nodes: [
      ...providerNodes.map((node) => ({
        name: node.name,
        kind: 'provider' as const,
        origin: node.origin,
        needs: node.needs,
        provides: node.provides,
      })),
      ...stepNodes.map((node) => ({
        name: node.name,
        kind: 'step' as const,
        origin: node.origin,
        needs: node.needs,
        provides: node.provides,
      })),
    ],
    routes: routePlans.map((plan) => ({
      pattern: plan.pattern,
      method: plan.method,
      transport: plan.transport,
      chain: [...plan.providers.map((node) => node.name), ...plan.steps.map((node) => node.name), plan.handlerName],
    })),
  };
}

/** Explains a single route: its match criteria and the ordered chain with each node's needs/provides. */
export function explainRoute(routePlans: RoutePlan[], routePath: string, booted: boolean): Explain {
  if (!booted)
    throw new Error(
      'explain() unavailable until a mesh app has booted: a mesh graph is not knowable until its teapots are asked. Call `await app.ready()` first — it is a no-op on a non-mesh app',
    );
  const plan = routePlans.find((candidate) => candidate.pattern === routePath);
  if (!plan) throw new Error(`no route: ${routePath}`);
  const toExplainNode = (node: GraphNode, kind: 'provider' | 'step'): ExplainNode => ({
    name: node.name,
    kind,
    origin: node.origin,
    needs: node.needs,
    provides: node.provides,
  });
  return {
    pattern: plan.pattern,
    method: plan.method,
    transport: plan.transport,
    chain: [
      ...plan.providers.map((node) => toExplainNode(node, 'provider')),
      ...plan.steps.map((node) => toExplainNode(node, 'step')),
      { name: plan.handlerName, kind: 'handler', origin: plan.origin, needs: plan.needs, provides: [] },
    ],
  };
}
