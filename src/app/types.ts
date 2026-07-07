import type http from 'http';
import type { Bus } from '../bus';
import type { GraphNode } from '../graph';
import type { GraphView } from '../graph-viz';
import type { HttpMethod, Transport } from '../metadata';
import { JsonTransformer } from '../transformers';

/** One entry in an {@link App.inspect} listing: a provider, step or handler and where it came from. */
export interface InspectLine {
  name: string;
  kind: 'provider' | 'step' | 'handler';
  origin: string;
}

/** A node in an {@link Explain} chain, annotated with the keys it needs and provides. */
export interface ExplainNode {
  name: string;
  kind: 'provider' | 'step' | 'handler';
  origin: string;
  needs: string[];
  provides: string[];
}

/** A full route explanation: its match criteria and the ordered provider/step/handler chain. */
export interface Explain {
  pattern: string;
  method: HttpMethod;
  transport: Transport;
  chain: ExplainNode[];
}

/** A running application instance with lifecycle, introspection and graph-export methods. */
export interface App {
  listen(port: number): Promise<http.Server>;
  close(): Promise<void>;
  inspect(routePath: string): InspectLine[];
  graph(): GraphView;
  toMermaid(): string;
  toDOT(): string;
  explain(routePath: string): Explain;
  /** Names of optional providers that failed to boot and are running degraded (empty until {@link App.listen}). */
  degraded(): string[];
  bus: Bus;
}

/** Internal per-route plan: match criteria, its resolved provider/step closure, and the compiled handler. */
export interface RoutePlan {
  pattern: string;
  method: HttpMethod;
  transport: Transport;
  origin: string;
  providers: GraphNode[];
  steps: GraphNode[];
  handlerName: string;
  needs: string[];
  run: (ctx: any) => Promise<unknown>;
  transformer: typeof JsonTransformer;
  duplicates?: 'array' | 'last';
}

/** Mesh networking options: a secret to gate this node's exports and/or remote teapots to connect to. */
export interface MeshConfig {
  secret?: string;
  teapots?: Array<{ url: string; secret: string }>;
  timeoutMs?: number;
}
