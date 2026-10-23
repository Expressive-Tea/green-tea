import type http from 'http';
import type https from 'https';
import { createRequestGate } from './request-gate';
import { renderError, type ErrorRequest } from '../transformers';
import type { Bus, Correlation } from '../bus';
import { readBody as readBodyBytes, deriveSecure, deriveIp } from './request';
import { pipeStream } from './stream';
import { attachWs } from './ws';
import { mergeInjectedHeaders, joinListHeaders } from './headers';
import {
  handle,
  correlateRequest,
  computeInjected,
  emitShedPair,
  watchingRequests,
  type HandleResult,
  type Preflight,
} from './core';
import type { BodyFailure, BodyReader } from './body';
import type { RouteTable, WsRouteDef, MeshControl, HttpOptions } from './types';
import { currentRoutes } from './router';
import type { Logger } from '../logger';
import { nodeRequire } from '../node-require';
import { answerProbe } from './health';
import { compressOutcome } from './compression';

interface HandlerConfig {
  routes: RouteTable;
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
 * @param routes HTTP route definitions, or a getter read once per request (a mesh teacup's table changes as peers come and go).
 * @param wsRoutes WebSocket route definitions (requires the optional `ws` peer dependency).
 * @param bus Optional event bus for stream lifecycle events.
 * @param meshControl Optional mesh gateway hook for a reserved upgrade path.
 * @param opts Limits, TLS, security, CORS, and body-parsing options.
 */
export function createHttpServer(
  routes: RouteTable,
  wsRoutes: WsRouteDef[] = [],
  bus?: Bus,
  meshControl?: MeshControl,
  opts?: HttpOptions,
): http.Server {
  const trustProxy = opts?.trustProxy ?? false;
  const handler = createRequestHandler({ routes, bus, opts, trustProxy });

  // Node http/https are loaded lazily so importing createApp stays edge/workerd-safe
  // (workerd's nodejs_compat provides no node:http/node:https). This path only runs under listen().
  const nodeHttp = nodeRequire<typeof import('http')>('http');
  const nodeHttps = nodeRequire<typeof import('https')>('https');

  // runtime-compatible; only @types differ (https.Server lacks the http-only timeout props)
  const server: http.Server = (opts?.tls
    ? nodeHttps.createServer(opts.tls as https.ServerOptions, handler)
    : nodeHttp.createServer(handler)) as unknown as http.Server;
  const maxConnections = opts?.limits?.maxConnections ?? 1000;

  if (maxConnections > 0) {
    server.maxConnections = maxConnections;
    let lastDropWarn = 0;
    server.on('drop', ({ remoteAddress, remotePort }) => {
      const now = Date.now();
      if (now - lastDropWarn < 60_000) return;
      lastDropWarn = now;
      opts?.logger?.warn(
        `maxConnections (${maxConnections}) reached \u2014 dropped connection from ${remoteAddress ?? 'unknown'}:${remotePort ?? 'unknown'}`,
        { maxConnections, remoteAddress, remotePort },
      );
    });
  }

  server.requestTimeout = opts?.limits?.requestTimeoutMs ?? 30_000;
  server.headersTimeout = opts?.limits?.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = opts?.limits?.keepAliveTimeoutMs ?? 5_000;
  attachWs(server, wsRoutes, bus, meshControl, opts?.streams, opts?.limits);
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
  const gate = createRequestGate(opts?.limits?.maxConcurrentRequests);

  // `http.createServer` ignores the promise a listener returns, so a rejection that escapes `serve`
  // would be an `unhandledRejection` — and under Node's default mode, the end of the process.
  // Caught here, at the one place every request passes through (#108).
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    serve(req, res).catch((err: unknown) => failSafe(res, err, opts?.logger));
  };

  async function serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Install the security-header patch BEFORE any routing/response so every path
    // (200, 404, error, stream) writes headers through the same patched writeHead.
    const secure = deriveSecure(req, trustProxy);
    // Derived before the body is read, so a 413 rejected below still carries an identity.
    const correlation = correlateRequest(req.headers);
    // One computation for the whole request: this object is patched into every response below, and
    // handed to `handle()` so routing does not derive it a second time — `security` is pure, but
    // `cors.origins` may be a predicate with a network call in it.
    const injected = computeInjected(opts, { secure, headers: req.headers });
    patchResponseHeaders(res, injected);

    if (writeProbe(req, res, opts)) return;

    let result: HandleResult | Preflight;
    let acquired = false;
    const watching = watchingRequests(bus);
    const startedAt = watching ? performance.now() : 0;

    try {
      if (!gate.acquire()) {
        if (watching)
          emitShedPair(
            bus,
            {
              method: req.method ?? 'GET',
              url: req.url ?? '/',
              requestId: correlation.requestId,
              traceId: correlation.traceId,
            },
            startedAt,
          );

        res.writeHead(503, {
          'content-type': 'application/json',
          'retry-after': '1',
          connection: 'close',
        });
        res.end(JSON.stringify({ error: 'Service Unavailable' }));
        return;
      }

      // Both the flag and the listener are skipped when no budget is configured, which is most
      // applications: `maxConcurrentRequests` is opt-in and unlimited by default. A closure and an
      // EventEmitter registration per request, on the hot path, for a feature that is off is a cost
      // with nothing on the other side of it.
      if (gate.limited) {
        acquired = true;
        res.once('close', () => {
          if (!acquired) return;
          acquired = false;
          gate.release();
        });
      }

      result = await handle(
        currentRoutes(routes), // once per request, see buildFetch
        opts,
        {
          ...correlation,
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          readBody,
          source: req,
          secure,
          ip: deriveIp(req, trustProxy),
        },
        injected,
      );
    } finally {
      if (acquired) {
        acquired = false;
        gate.release();
      }
    }

    await writeResult(req, res, result, { opts, bus, correlation });
  }
}

/**
 * Writes what `handle()` produced: a preflight, or an outcome after `compressOutcome` (CARD-16).
 * Module scope rather than inside `serve`, whose closure would charge every branch here again.
 */
async function writeResult(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  result: HandleResult | Preflight,
  ctx: { opts: HttpOptions | undefined; bus: Bus | undefined; correlation: Correlation },
): Promise<void> {
  const { opts, bus, correlation } = ctx;

  if ('preflight' in result) {
    res.writeHead(204, result.preflight);
    res.end();
    return;
  }

  // Not awaited unless compression actually returned a promise: an app without it keeps the
  // synchronous write it had.
  const decided = compressOutcome(
    opts?.compression,
    { method: req.method ?? 'GET', headers: req.headers },
    result.outcome,
  );
  const outcome = decided instanceof Promise ? await decided : decided;

  if (outcome.kind === 'stream') {
    await pipeStream(res, outcome, bus, opts?.streams, correlation);
    return;
  }

  res.writeHead(outcome.status, outcome.headers);
  res.end(outcome.body);
}

/**
 * Answers a health probe and returns true, or returns false for any other request. Runs before the
 * gate, so shedding never refuses a probe, and before `handle()`, so no step, plugin or lifecycle
 * event sees one. Written through the patched writeHead, so the security headers still land.
 */
function writeProbe(req: http.IncomingMessage, res: http.ServerResponse, opts: HttpOptions | undefined): boolean {
  const probe = opts?.health && answerProbe(req.method ?? 'GET', req.url ?? '/', opts.health);
  if (!probe) return false;

  res.writeHead(probe.status, probe.headers);
  res.end(probe.body);
  return true;
}

/**
 * The last resort for a request whose handling rejected. Deliberately does not call `onError`: this
 * runs because something already failed past the point where errors convert to a response, and user
 * code that may be the thing failing is the wrong place to send it. Must never throw — nothing
 * catches it.
 *
 * Writable: a fixed 500 with `connection: close`, still through the patched `writeHead`, so the
 * security headers land. Output already started, or the client gone: there is no honest response
 * left to send, so the socket is destroyed and the client sees a truncated reply rather than a
 * complete-looking one. No `request:end` is emitted — observers do not alter the response, and the
 * core never completed this request.
 */
function failSafe(res: http.ServerResponse, err: unknown, logger: Logger | undefined): void {
  try {
    logger?.error('request listener failed', { err: err instanceof Error ? err.message : String(err) });
  } catch {
    /* a broken logger must not stop the response below */
  }

  if (res.headersSent || res.destroyed || !res.writable) {
    res.destroy();
    return;
  }

  try {
    res.writeHead(500, { 'content-type': 'application/json', connection: 'close' });
    res.end('{"error":"Internal Server Error"}');
  } catch {
    res.destroy();
  }
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
      const rendered = renderError(error, errorRequest(req), opts?.onError, opts?.logger);
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
    const merged = joinListHeaders(mergeInjectedHeaders(handlerHeaders, injected));
    return typeof arg2 === 'string' ? origWriteHead(status, arg2, merged) : origWriteHead(status, merged);
  };
}
