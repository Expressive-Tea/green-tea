import type http from 'http';
import type https from 'https';
import { renderError, type ErrorRequest } from '../transformers';
import type { Bus } from '../bus';
import { buildSecurityHeaders, resolveCors } from '../security';
import { readBody as readBodyBytes, deriveSecure, deriveIp } from './request';
import { pipeStream } from './stream';
import { attachWs } from './ws';
import { mergeInjectedHeaders } from './headers';
import { handle, correlateRequest } from './core';
import type { BodyFailure, BodyReader } from './body';
import type { RouteDef, WsRouteDef, MeshControl, HttpOptions } from './types';

interface HandlerConfig {
  routes: RouteDef[];
  bus?: Bus;
  opts?: HttpOptions;
  trustProxy: boolean;
}

/** Builds the {@link ErrorRequest} handed to a user error renderer. */
function errorRequest(req: http.IncomingMessage): ErrorRequest {
  return { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers };
}

/**
 * Builds an HTTP/HTTPS server that routes requests, parses bodies, streams results, and handles WebSocket upgrades.
 * @param routes HTTP route definitions.
 * @param wsRoutes WebSocket route definitions (requires the optional `ws` peer dependency).
 * @param bus Optional event bus for stream lifecycle events.
 * @param meshControl Optional mesh gateway hook for a reserved upgrade path.
 * @param opts Limits, TLS, security, CORS, and body-parsing options.
 */
export function createHttpServer(
  routes: RouteDef[],
  wsRoutes: WsRouteDef[] = [],
  bus?: Bus,
  meshControl?: MeshControl,
  opts?: HttpOptions,
): http.Server {
  const trustProxy = opts?.trustProxy ?? false;
  const handler = createRequestHandler({ routes, bus, opts, trustProxy });

  // Node http/https are loaded lazily so importing createApp stays edge/workerd-safe
  // (workerd's nodejs_compat provides no node:http/node:https). This path only runs under listen().
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeHttp = require('http') as typeof import('http');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeHttps = require('https') as typeof import('https');

  // runtime-compatible; only @types differ (https.Server lacks the http-only timeout props)
  const server: http.Server = (opts?.tls
    ? nodeHttps.createServer(opts.tls as https.ServerOptions, handler)
    : nodeHttp.createServer(handler)) as unknown as http.Server;
  const maxConnections = opts?.limits?.maxConnections ?? 1000;

  if (maxConnections > 0) {
    server.maxConnections = maxConnections;
    server.once('drop', ({ remoteAddress, remotePort }) => {
      console.warn(
        `[green-tea] maxConnections (${maxConnections}) reached — dropped connection from ${remoteAddress}:${remotePort}.`,
      );
    });
  }

  server.requestTimeout = opts?.limits?.requestTimeoutMs ?? 30_000;
  server.headersTimeout = opts?.limits?.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = opts?.limits?.keepAliveTimeoutMs ?? 5_000;
  attachWs(server, wsRoutes, bus, meshControl, opts?.streams);
  return server;
}

/**
 * Builds the request listener: a thin Node adapter around the runtime-neutral {@link handle} core.
 * Describes the request, supplies the {@link BodyReader} the core calls once a route matches, then
 * writes the result to `res` (buffered or streamed). Routing, body parsing, limits and error
 * rendering all live in the core. The security-header monkeypatch is installed here — and stays the
 * single source of truth for merging headers into every response — so `handle()`'s own `injected`
 * is intentionally unused by this adapter.
 */
function createRequestHandler(cfg: HandlerConfig) {
  const { routes, bus, opts, trustProxy } = cfg;
  // Built once per server, not once per request — see `BodyReader`.
  const readBody: BodyReader = (source, limit) => readRequestBytes(source, limit, opts);

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // Install the security-header patch BEFORE any routing/response so every path
    // (200, 404, error, stream) writes headers through the same patched writeHead.
    const secure = deriveSecure(req, trustProxy);
    // Derived before the body is read, so a 413 rejected below still carries an identity.
    const correlation = correlateRequest(req.headers);
    const injected: Record<string, string> = { ...buildSecurityHeaders(opts?.security ?? true, secure) };
    patchResponseHeaders(res, injected);

    // CORS is added to `injected` AFTER the patch is installed — the patch reads it lazily
    // by reference at writeHead time, so keys added here still land on every response.
    if (opts?.cors) Object.assign(injected, resolveCors(opts.cors, req));

    const result = await handle(routes, opts, {
      ...correlation,
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: req.headers,
      readBody,
      source: req,
      secure,
      ip: deriveIp(req, trustProxy),
    });

    if ('preflight' in result) {
      res.writeHead(204, result.preflight);
      res.end();
      return;
    }

    if (result.outcome.kind === 'stream') {
      await pipeStream(res, result.outcome.stream, result.outcome.encoder, bus, result.outcome.route, opts?.streams);
      return;
    }

    res.writeHead(result.outcome.status, result.outcome.headers);
    res.end(result.outcome.body);
  };
}

/**
 * The Node half of body acquisition: bytes off the socket, and the over-limit answer.
 *
 * `readBody` enforces the limit against the running total as chunks arrive, so an oversized upload
 * is rejected without being buffered. `connection: close` on that response is load-bearing — it
 * stops the remainder of the upload from continuing to arrive on a kept-alive socket.
 */
function readRequestBytes(
  source: unknown,
  limit: number,
  opts: HttpOptions | undefined,
): Promise<{ bytes: Buffer | undefined } | BodyFailure> {
  const req = source as http.IncomingMessage;

  return readBodyBytes(req, limit).then(
    (bytes) => ({ bytes }),
    (error: unknown) => {
      const rendered = renderError(error, errorRequest(req), opts?.onError);
      return { fail: { ...rendered, headers: { ...rendered.headers, connection: 'close' } } };
    },
  );
}

/**
 * Monkey-patches `res.writeHead` so injected (security/CORS) headers are authoritative on every response.
 * Handler headers that case-insensitively collide with an injected key are dropped; `Vary` is merged.
 * Reads `injected` by reference, so CORS keys added after installation still land.
 */
function patchResponseHeaders(res: http.ServerResponse, injected: Record<string, string>): void {
  const origWriteHead = res.writeHead.bind(res);

  (res as any).writeHead = (status: number, arg2?: any, arg3?: any) => {
    const handlerHeaders = (typeof arg2 === 'string' ? arg3 : arg2) as Record<string, any> | undefined;
    const merged = mergeInjectedHeaders(handlerHeaders, injected);
    return typeof arg2 === 'string' ? origWriteHead(status, arg2, merged) : origWriteHead(status, merged);
  };
}
