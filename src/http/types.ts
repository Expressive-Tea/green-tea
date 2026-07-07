import http from 'http';
import type { Transport } from '../metadata';
import type { PipelineResult } from '../pipeline';
import type { TlsOptions, SecurityOptions, CorsOptions } from '../security';

/** Per-request size and timeout ceilings applied by the server. */
export interface RequestLimits {
  maxBodyBytes?: number; // default 1_000_000
  requestTimeoutMs?: number; // default 30_000
  headersTimeoutMs?: number; // default 10_000
  keepAliveTimeoutMs?: number; // default 5_000
  maxParts?: number; // default 1000
}

/** Options controlling server construction: limits, TLS, proxy trust, security headers, CORS, and body parsing. */
export interface HttpOptions {
  limits?: RequestLimits;
  streams?: Set<() => void>;
  tls?: TlsOptions;
  trustProxy?: boolean;
  security?: boolean | SecurityOptions;
  cors?: CorsOptions;
  bodyDuplicates?: 'array' | 'last';
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
}) => Promise<PipelineResult>;

/** A registered HTTP route: method, path pattern, streaming transport, and handler. */
export interface RouteDef {
  method: string;
  pattern: string;
  transport: Transport;
  handler: RouteHandler;
  bodyDuplicates?: 'array' | 'last';
}

/** Result of matching a request path against a route: extracted params plus the matched definition. */
export interface MatchedRoute {
  params: Record<string, string>;
  def: RouteDef;
}

/** Context passed to a WebSocket route's `open`: path params, inbound message stream, abort signal, and raw request. */
export interface WsOpenCtx {
  params: Record<string, string>;
  inbound: AsyncIterable<unknown>;
  abort: AbortSignal;
  req: http.IncomingMessage;
}

/** A registered WebSocket route: path pattern and an `open` that returns the outbound message stream. */
export interface WsRouteDef {
  pattern: string;
  open: (ctx: WsOpenCtx) => Promise<AsyncIterable<unknown>>;
}

/** Hook for a mesh gateway to take over WebSocket upgrades on a fixed path. */
export interface MeshControl {
  path: string;
  handle(ws: any, req: http.IncomingMessage): void;
}
