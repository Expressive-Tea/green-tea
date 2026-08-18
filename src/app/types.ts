import type http from 'http';
import type { Bus } from '../bus';
import type { Logger } from '../logger';
import type { TeardownFn } from '../lifecycle';
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
  close(options?: { timeoutMs?: number }): Promise<void>;
  /**
   * Resolves the dependency graph, then returns. For a mesh app that means connecting to its
   * teapots and splicing their scopes in — a mesh graph is not knowable without asking. For every
   * other app it is a no-op, so code holding an `App` can `await app.ready()` before
   * `inspect()`/`graph()`/`explain()` without caring which kind it was handed.
   *
   * Deliberately *not* a full boot: it does not run provider factories. Resolving the graph and
   * being ready to serve are different things, and drawing a diagram should not open your
   * database connections. Serving (`fetch`/`upgrade`/`listen`) boots the providers as well, and
   * shares this same memoized step — calling both never resolves the graph twice.
   */
  ready(): Promise<void>;
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
  /**
   * Where framework diagnostics are written — the one passed to `createApp({ logger })`, or the
   * default. Exposed so the Deno and Bun adapters report through the application's logger rather
   * than reaching past it to `console`, and so a plugin or a test can read what core would write.
   */
  logger: Logger;
}

/** Internal per-route plan: match criteria, its resolved provider/step closure, and the compiled handler. */
export interface RoutePlan {
  pattern: string;
  method: HttpMethod;
  transport: Transport;
  origin: string;
  declaration: string;
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
  /** How long an RPC may wait for its teapot before failing with 504 (default: 30s). */
  timeoutMs?: number;
  /**
   * Gap between heartbeat pings to each teapot (default: 15s). Two unanswered rounds close the
   * link, so a half-open connection surfaces as an immediate 503 instead of every request paying
   * `timeoutMs` first. Lower it to notice a dead teapot sooner, at the cost of more chatter.
   */
  heartbeatMs?: number;
  /**
   * Reconnect to a teapot after its link drops (default: on). A dropped link used to stay dead for
   * the life of the process, which meant deploying a teapot forced a restart of every teacup.
   *
   * `false` restores that fail-once behaviour. An object tunes the backoff, which doubles from
   * `initialDelayMs` (500ms) up to `maxDelayMs` (30s) with jitter, so teacups that went down
   * together do not come back in lockstep.
   */
  reconnect?: boolean | { initialDelayMs?: number; maxDelayMs?: number };
  /**
   * What to do when a returning teapot's manifest no longer exports something the graph was
   * validated against at boot (default: `'refuse'`).
   *
   * `'refuse'` hangs up on that session and keeps retrying — a partial deploy may still restore it.
   * Serving against a manifest that no longer backs the graph would surface as a 500 that looks
   * like application code. A future `'reconcile'` will rebuild the graph instead; it is named here
   * rather than left implicit so that arriving is additive rather than a change of default.
   */
  onManifestChange?: 'refuse';
}

/**
 * Lifecycle participation for an application that does not want to be a plugin.
 *
 * Every method is optional, and the shape is an object rather than a single callback so later
 * stages (`onBoot`, `onReady`) can be added without a breaking change. Only `onShutdown` exists.
 */
export interface Hooks {
  /** Run before the app closes. Awaited, bounded by `close()`'s deadline, failures logged. */
  onShutdown?: TeardownFn;
}
