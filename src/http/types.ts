import type { Transport } from '../metadata';
import type { HealthProbe } from './health';
import type { PipelineResult } from '../pipeline';
import type { ErrorRenderer } from '../transformers';
import type { TlsOptions, SecurityOptions, CorsOptions } from '../security';
import type { WsRequest, WsSocket } from './ws-core';
import type { StaticResolver } from '../views';
import type { Bus } from '../bus';
import type { Logger } from '../logger';

/** Per-request and per-server resource ceilings applied by the server. */
export interface RequestLimits {
  maxBodyBytes?: number; // default 1_000_000
  maxConnections?: number; // default 1000; <= 0 means unlimited (Node only)
  maxConcurrentRequests?: number; // default unlimited; <= 0 means unlimited
  requestTimeoutMs?: number; // default 30_000
  headersTimeoutMs?: number; // default 10_000
  keepAliveTimeoutMs?: number; // default 5_000
  maxParts?: number; // default 1000
  /**
   * Largest inbound WebSocket message, in bytes (UTF-8 bytes for text), per connection. Default
   * `1_048_576` (1 MiB). A larger message closes the connection with `1009` (`message too large`);
   * a fragmented message counts as a whole. Must be a positive integer, or `createApp` throws.
   *
   * Node and Bun refuse an oversized frame before buffering it (`ws`'s `maxPayload`, Bun's
   * `maxPayloadLength`). Before Bun 1.4, Bun then drops the connection without a close frame, so
   * the peer sees `1006` instead of `1009`; Bun 1.4 and later send `1009`. Deno and the edge offer no such option: there the runtime
   * receives the whole message first, so its memory is bounded by the platform's own cap, and this
   * limit is checked after receipt — the connection still closes `1009`.
   *
   * Server-level only; there is no per-route override.
   */
  maxWsMessageBytes?: number;
  /**
   * Inbound WebSocket messages a connection may hold that the handler has not read yet. Default
   * `16`. One more closes the connection with `1013` (`inbound queue full`) rather than dropping
   * anything, so a handler that never reads `inbound` is closed once its peer sends 17 messages.
   * Must be a positive integer, or `createApp` throws. Applies on every runtime.
   *
   * Worst-case buffered inbound memory is about `maxConnections × maxWsQueue × maxWsMessageBytes`:
   * ≈ 15.6 GiB at the defaults on Node. Deno and Bun have no connection cap, so cap connections at
   * the platform or proxy there. Server-level only; there is no per-route override.
   */
  maxWsQueue?: number;
}

/** Options controlling server construction: limits, TLS, proxy trust, security headers, CORS, and body parsing. */
export interface HttpOptions {
  /**
   * Lifecycle events go here. Carried on the options rather than as a parameter so `handle()` —
   * the one place both the Node and Fetch adapters meet — can emit without either adapter growing
   * a separate channel for it.
   */
  bus?: Bus;
  /** Where this server writes diagnostics. Optional because `createHttpServer` takes no options at all in tests. */
  logger?: Logger;
  limits?: RequestLimits;
  streams?: Set<() => void>;
  tls?: TlsOptions;
  trustProxy?: boolean;
  security?: boolean | SecurityOptions;
  cors?: CorsOptions;
  bodyDuplicates?: 'array' | 'last';
  onError?: ErrorRenderer;
  static?: StaticResolver;
  /**
   * Answers `/__live__` and `/__ready__` ahead of the gate and the route table (`createApp({ health })`).
   * Absent when health is off, so no path is intercepted.
   */
  health?: HealthProbe;
}

/** Handler for a matched HTTP route; receives a normalized request and resolves to a pipeline result. */
export type RouteHandler = (req: {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  protocol: 'http' | 'https';
  ip: string;
  /** Correlates every lifecycle event this request emits; see `correlateRequest` in `./core`. */
  requestId: string;
  /** An incoming `traceparent`, carried verbatim for an exporter to interpret. */
  traceId?: string;
}) => Promise<PipelineResult>;

/** A registered HTTP route: method, path pattern, streaming transport, and handler. */
export interface RouteDef {
  method: string;
  pattern: string;
  transport: Transport;
  handler: RouteHandler;
  bodyDuplicates?: 'array' | 'last';
  maxBodyBytes?: number; // per-route override of the server's maxBodyBytes
  maxParts?: number; // per-route override of the server's multipart maxParts
}

/**
 * A route table: a fixed array, or a getter the server reads once per request. A mesh teacup passes
 * a getter, because its remote routes change as teapots come and go (CARD-19); each change publishes
 * a new array, so a request sees the whole old table or the whole new one.
 */
export type RouteTable = RouteDef[] | (() => RouteDef[]);

/** Result of matching a request path against a route: extracted params plus the matched definition. */
export interface MatchedRoute {
  params: Record<string, string>;
  def: RouteDef;
}

/** Context passed to a WebSocket route's `open`: path params, inbound message stream, abort signal, and neutral request. */
export interface WsOpenCtx {
  params: Record<string, string>;
  inbound: AsyncIterable<unknown>;
  abort: AbortSignal;
  req: WsRequest;
}

/** A registered WebSocket route: path pattern and an `open` that returns the outbound message stream. */
export interface WsRouteDef {
  pattern: string;
  open: (ctx: WsOpenCtx) => Promise<AsyncIterable<unknown>>;
}

/** Hook for a mesh gateway to take over WebSocket upgrades on a fixed path. */
export interface MeshControl {
  path: string;
  /**
   * Serves one control connection over the neutral socket — the same capability every other ws
   * consumer takes, so Node (via `nodeSocket`) and Deno/Bun (via `app.upgrade`) both feed it.
   * Resolves when the connection ends, like `runWsConnection`.
   */
  handle(socket: WsSocket): Promise<void>;
}
