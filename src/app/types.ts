import type http from 'http';
import type { Bus } from '../bus';
import type { GraphNode } from '../graph';
import type { GraphView } from '../graph-viz';
import type { HttpMethod, Transport } from '../metadata';
import type { ArgSpec } from '../params';
import type { OpenApiDoc, OpenApiInfo } from '../openapi';
import type { WsRequest, WsSocket } from '../http/ws-core';
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
  /** Web-Standards handler: run a Fetch API Request through the graph and return a Response (Node/Deno/Bun/edge). WS not included. */
  fetch(request: Request): Promise<Response>;
  /** Run a WebSocket upgrade through the graph using an adapter-provided socket (Deno/Bun/edge). Node uses its own listener path. */
  upgrade(request: WsRequest, socket: WsSocket): Promise<void>;
  inspect(routePath: string): InspectLine[];
  graph(): GraphView;
  toMermaid(): string;
  toDOT(): string;
  explain(routePath: string): Explain;
  /** Generate a structural OpenAPI 3.1 document from the registered routes. */
  openapi(info?: OpenApiInfo): OpenApiDoc;
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
  maxBodyBytes?: number;
  maxParts?: number;
  args: ArgSpec[];
}

/** Mesh networking options: a secret to gate this node's exports and/or remote teapots to connect to. */
export interface MeshConfig {
  secret?: string;
  teapots?: Array<{ url: string; secret: string }>;
  timeoutMs?: number;
}
