// src/http/core.ts — runtime-neutral request handling core, shared by the Node adapter and (later) app.fetch.
import { HttpError, NotFound } from '../signals';
import { renderError } from '../transformers';
import { isStreamResult, type PipelineResult } from '../pipeline';
import { buildSecurityHeaders, resolveCors, corsPreflightHeaders } from '../security';
import { matchRoute, allowedMethods, parseQuery } from './router';
import { pickEncoder } from './stream';
import type { RouteDef, HttpOptions } from './types';
import type { StreamEncoder } from '../encoders';

/** A runtime-neutral inbound request: body already parsed by the caller's ingress (Node stream, fetch Request, …). */
export interface NeutralRequest {
  method: string;
  url: string; // path + query, e.g. "/users/9?x=1"
  headers: Record<string, string | string[] | undefined>;
  body: unknown; // already-parsed body
  secure: boolean;
  ip: string;
}

/** The neutral shape of a response: a fully buffered body, or a stream to pipe frame-by-frame. */
export type NeutralOutcome =
  | { kind: 'buffered'; status: number; headers: Record<string, string>; body: string | Buffer }
  | { kind: 'stream'; headers: Record<string, string>; stream: AsyncIterable<unknown>; encoder: StreamEncoder };

/** {@link handle}'s result for a normal (non-preflight) request. */
export interface HandleResult {
  injected: Record<string, string>;
  outcome: NeutralOutcome;
}

/** {@link handle}'s result for a CORS preflight: the caller must answer with 204 + these headers. */
export interface Preflight {
  preflight: Record<string, string>;
}

/**
 * Computes the security + CORS headers that get injected into every response for a request — the same
 * authoritative set {@link handle} applies to its outcomes. Shared with `buildFetch` (src/http/web.ts)
 * so early-failure responses (413/400/501, before a route even matches) carry the same headers Node's
 * `patchResponseHeaders` would have installed up-front.
 */
export function computeInjected(
  opts: HttpOptions | undefined,
  req: { secure: boolean; headers: Record<string, string | string[] | undefined> },
): Record<string, string> {
  const injected: Record<string, string> = { ...buildSecurityHeaders(opts?.security ?? true, req.secure) };
  if (opts?.cors) Object.assign(injected, resolveCors(opts.cors, req));
  return injected;
}

/**
 * Runtime-neutral request handler: security/CORS headers, preflight short-circuit, route match / 404 / 405,
 * route-handler invocation with error rendering, and the buffered-vs-stream decision. Does no I/O — the
 * caller (a Node adapter, a fetch adapter, …) reads/writes the actual request/response.
 */
export async function handle(
  routes: RouteDef[],
  opts: HttpOptions | undefined,
  req: NeutralRequest,
): Promise<HandleResult | Preflight> {
  const path = req.url.split('?')[0];
  const injected = computeInjected(opts, req);

  if (opts?.cors && req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    return { preflight: corsPreflightHeaders(opts.cors, req) };
  }

  const matched = matchRoute(routes, req.method, path);

  if (!matched) {
    // Path matches a route under a different method → 405 with Allow; otherwise 404.
    const allow = allowedMethods(routes, path);
    const err = allow.length ? new HttpError(405, 'Method Not Allowed') : new NotFound('Not Found');
    const rendered = renderError(err, { method: req.method, url: req.url, headers: req.headers }, opts?.onError);
    const headers = allow.length ? { ...rendered.headers, allow: allow.join(', ') } : rendered.headers;
    return { injected, outcome: { kind: 'buffered', status: rendered.status, headers, body: rendered.body } };
  }

  let result: PipelineResult;

  try {
    result = await matched.def.handler({
      method: req.method,
      url: req.url,
      headers: req.headers,
      params: matched.params,
      query: parseQuery(req.url),
      body: req.body,
      protocol: req.secure ? 'https' : 'http',
      ip: req.ip,
    });
  } catch (error) {
    result = renderError(error, { method: req.method, url: req.url, headers: req.headers }, opts?.onError);
  }

  if (isStreamResult(result)) {
    const encoder = pickEncoder(matched.def.transport, String(req.headers.accept ?? ''));
    return { injected, outcome: { kind: 'stream', headers: encoder.headers, stream: result.stream, encoder } };
  }

  return { injected, outcome: { kind: 'buffered', status: result.status, headers: result.headers, body: result.body } };
}
