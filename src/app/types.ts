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
   * Wires `SIGINT`/`SIGTERM` to `closer` and returns a close that also unregisters them — or
   * returns `closer` untouched when `createApp({ handleSignals })` was not set.
   *
   * `listen()`, `serveDeno()` and `serveBun()` each call this with the closer that actually drains
   * their server, which is why the option is declared once on `createApp` and works on all three.
   * Call it yourself only if you serve the app some other way.
   */
  handleSignals<T extends (options?: { timeoutMs?: number }) => Promise<void>>(closer: T): T;
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
  /**
   * Boots the providers now, instead of on the first request.
   *
   * `listen()` already does this before it accepts a connection. Every other path — `app.fetch`,
   * `app.upgrade`, `serveDeno`, `serveBun`, `edgeHandler` — boots lazily on the first request, and a
   * provider that throws there fails *every* request, answered by the runtime with a 500 that never
   * reaches `onError`. Calling this first turns that into a startup failure, which is where a bad
   * key or an unreachable database belongs.
   *
   * Idempotent, and shares its memo with `listen()` and `fetch()`: calling both boots once. Unlike
   * `ready()`, it does run provider factories.
   *
   * On workerd there is no startup outside a request, so calling it moves nothing.
   */
  boot(): Promise<void>;
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
  /**
   * How long boot keeps trying to reach a teapot before giving up on it (default: `timeoutMs`,
   * so 30s). Attempts use the same backoff as reconnection.
   *
   * A teapot that is merely slow to start — a container scheduled a moment later, a network that
   * has not settled — should not fail a deploy, and this is the grace for that. When the deadline
   * passes the teacup warns and starts anyway: every export is a step or a proxied route, so
   * nothing needed that link resolved by boot.
   *
   * Starting is not degrading, though. A teapot that never connected sent no manifest, so none of
   * its steps or routes are registered: its routes 404 rather than 503, and a local node that needs
   * one of its tokens still fails the boot, naming it. A permanent refusal — a wrong secret, a
   * protocol mismatch — fails at once without spending the grace.
   *
   * `0` means one attempt and no grace. That is the attempt count boot used to have, and nothing
   * more: exhausting it no longer fails the boot, so a single unreachable teapot still warns and
   * starts. To make a teapot's absence fatal, have something local `@needs` one of its tokens.
   */
  bootTimeoutMs?: number;
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
