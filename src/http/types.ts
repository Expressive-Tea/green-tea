import type { Transport } from '../metadata';
import type { PipelineResult } from '../pipeline';
import type { ErrorRenderer } from '../transformers';
import type { TlsOptions, SecurityOptions, CorsOptions } from '../security';
import type { WsRequest, WsSocket } from './ws-core';
import type { StaticResolver } from '../views';
import type { Bus } from '../bus';

/** Per-request and per-server resource ceilings applied by the server. */
export interface RequestLimits {
  maxBodyBytes?: number; // default 1_000_000
  maxConnections?: number; // default 1000; <= 0 means unlimited (Node only)
  maxConcurrentRequests?: number;
  requestTimeoutMs?: number; // default 30_000
  headersTimeoutMs?: number; // default 10_000
  keepAliveTimeoutMs?: number; // default 5_000
  maxParts?: number; // default 1000
}

/** Options controlling server construction: limits, TLS, proxy trust, security headers, CORS, and body parsing. */
export interface HttpOptions {
  /**
   * Lifecycle events go here. Carried on the options rather than as a parameter so `handle()` —
   * the one place both the Node and Fetch adapters meet — can emit without either adapter growing
   * a separate channel for it.
   */
  bus?: Bus;
  limits?: RequestLimits;
  streams?: Set<() => void>;
  tls?: TlsOptions;
  trustProxy?: boolean;
  security?: boolean | SecurityOptions;
  cors?: CorsOptions;
  bodyDuplicates?: 'array' | 'last';
  onError?: ErrorRenderer;
  static?: StaticResolver;
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
