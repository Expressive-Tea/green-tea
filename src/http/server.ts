import http from 'http';
import https from 'https';
import { renderError, type ErrorRequest } from '../transformers';
import { isHttpError, HttpError } from '../signals';
import type { Bus } from '../bus';
import { buildSecurityHeaders, resolveCors } from '../security';
import { parseMultipart, extractBoundary, collapseDuplicates } from '../multipart';
import { matchRoute } from './router';
import { readBody, deriveSecure, deriveIp } from './request';
import { pipeStream } from './stream';
import { attachWs } from './ws';
import { mergeInjectedHeaders } from './headers';
import { handle } from './core';
import type { RouteDef, WsRouteDef, MatchedRoute, MeshControl, HttpOptions } from './types';

interface HandlerConfig {
  routes: RouteDef[];
  bus?: Bus;
  opts?: HttpOptions;
  maxBody: number;
  trustProxy: boolean;
}

/** A ready-to-send error response produced while acquiring the request body. */
type BodyFailure = { fail: { status: number; headers: Record<string, string>; body: string } };

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
  const maxBody = opts?.limits?.maxBodyBytes ?? 1_000_000;
  const trustProxy = opts?.trustProxy ?? false;
  const handler = createRequestHandler({ routes, bus, opts, maxBody, trustProxy });

  // runtime-compatible; only @types differ (https.Server lacks the http-only timeout props)
  const server: http.Server = (opts?.tls
    ? https.createServer(opts.tls as https.ServerOptions, handler)
    : http.createServer(handler)) as unknown as http.Server;
  server.requestTimeout = opts?.limits?.requestTimeoutMs ?? 30_000;
  server.headersTimeout = opts?.limits?.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = opts?.limits?.keepAliveTimeoutMs ?? 5_000;
  attachWs(server, wsRoutes, bus, meshControl, opts?.streams);
  return server;
}

/**
 * Builds the request listener: a thin Node adapter around the runtime-neutral {@link handle} core.
 * Reads the body (Node-specific), delegates security/CORS/routing/error-rendering to `handle()`,
 * then writes the result to `res` (buffered or streamed). The security-header monkeypatch is
 * installed here — and stays the single source of truth for merging headers into every response —
 * so `handle()`'s own `injected` is intentionally unused by this adapter.
 */
function createRequestHandler(cfg: HandlerConfig) {
  const { routes, bus, opts, maxBody, trustProxy } = cfg;

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    const method = req.method ?? 'GET';
    // Install the security-header patch BEFORE any routing/response so every path
    // (200, 404, error, stream) writes headers through the same patched writeHead.
    const secure = deriveSecure(req, trustProxy);
    const injected: Record<string, string> = { ...buildSecurityHeaders(opts?.security ?? true, secure) };
    patchResponseHeaders(res, injected);

    // CORS is added to `injected` AFTER the patch is installed — the patch reads it lazily
    // by reference at writeHead time, so keys added here still land on every response.
    if (opts?.cors) Object.assign(injected, resolveCors(opts.cors, req));

    // Mirror handle()'s own preflight/route-match decision here, so we only read the body
    // (below) for a request that actually reaches a route handler — matching prior behaviour.
    const isPreflight = Boolean(opts?.cors && method === 'OPTIONS' && req.headers['access-control-request-method']);
    const matched = isPreflight ? undefined : matchRoute(routes, method, path);

    let body: unknown;

    if (matched) {
      const acquired = await acquireBody(req, matched, opts, maxBody);

      if ('fail' in acquired) {
        res.writeHead(acquired.fail.status, acquired.fail.headers);
        res.end(acquired.fail.body);
        return;
      }

      body = acquired.body;
    }

    const result = await handle(routes, opts, {
      method,
      url,
      headers: req.headers,
      body,
      secure,
      ip: deriveIp(req, trustProxy),
    });

    if ('preflight' in result) {
      res.writeHead(204, result.preflight);
      res.end();
      return;
    }

    if (result.outcome.kind === 'stream') {
      await pipeStream(res, result.outcome.stream, result.outcome.encoder, bus, matched?.def.pattern, opts?.streams);
      return;
    }

    res.writeHead(result.outcome.status, result.outcome.headers);
    res.end(result.outcome.body);
  };
}

/** Reads and parses the request body, returning `{ body }` or a ready-to-send `{ fail }` error response. */
async function acquireBody(
  req: http.IncomingMessage,
  matched: MatchedRoute,
  opts: HttpOptions | undefined,
  maxBody: number,
): Promise<{ body: unknown } | BodyFailure> {
  let buf: Buffer | undefined;
  const bodyLimit = matched.def.maxBodyBytes ?? maxBody; // per-route override falls back to the server default

  try {
    buf = await readBody(req, bodyLimit);
  } catch (error) {
    const rendered = renderError(error, errorRequest(req), opts?.onError);
    return { fail: { ...rendered, headers: { ...rendered.headers, connection: 'close' } } };
  }

  const contentType = String(req.headers['content-type'] ?? '');
  const duplicates = matched.def.bodyDuplicates ?? opts?.bodyDuplicates ?? 'last';
  const maxParts = matched.def.maxParts ?? opts?.limits?.maxParts ?? 1000;
  const parsed = await parseRequestBody(buf, contentType, duplicates, maxParts);

  if ('error' in parsed) {
    const rendered = renderError(new HttpError(parsed.status ?? 400, parsed.error), errorRequest(req), opts?.onError);
    return { fail: rendered };
  }

  return { body: parsed.body };
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

/** Parse outcome: the decoded body, or an error message plus the status to send (400 unless set). */
type ParseResult = { body: unknown } | { error: string; status?: number };

/**
 * Parses a raw request body by content type (JSON, urlencoded, multipart, or plain text).
 * @returns `{ body }` on success, or `{ error, status? }` on malformed input / missing multipart support.
 */
async function parseRequestBody(
  buf: Buffer | undefined,
  contentType: string,
  duplicates: 'array' | 'last',
  maxParts: number,
): Promise<ParseResult> {
  if (buf !== undefined && contentType.includes('application/json')) {
    try {
      return { body: JSON.parse(buf.toString('utf8')) };
    } catch {
      return { error: 'Invalid JSON body' };
    }
  }

  if (buf !== undefined && contentType.includes('application/x-www-form-urlencoded')) {
    return { body: collapseDuplicates(new URLSearchParams(buf.toString('utf8')), duplicates) };
  }

  if (buf !== undefined && contentType.includes('multipart/form-data')) {
    const boundary = extractBoundary(contentType);
    if (!boundary) return { error: 'Invalid multipart body' };

    try {
      return { body: await parseMultipart(buf, boundary, { maxParts, duplicates }) };
    } catch (error) {
      // HttpError = the busboy peer dep is missing (501); anything else = malformed input (400).
      if (isHttpError(error)) return { error: error.message, status: error.status };
      return { error: 'Invalid multipart body' };
    }
  }

  const text = buf?.toString('utf8');
  return { body: text === '' ? undefined : text };
}
