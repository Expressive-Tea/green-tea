// src/http/core.ts — runtime-neutral request handling core, shared by the Node adapter and (later) app.fetch.
import { HttpError, NotFound } from '../signals';
import { renderError } from '../transformers';
import { isStreamResult, type PipelineResult } from '../pipeline';
import { buildSecurityHeaders, resolveCors, corsPreflightHeaders } from '../security';
import { resolveRoute, allowedMethods, normalizeRequestPath, parseQuery } from './router';
import { pickEncoder } from './stream';
import type { RouteDef, HttpOptions } from './types';
import type { StreamEncoder } from '../encoders';

// The project tsconfig's `lib` is `es2020` with no `DOM`, so the Web Crypto global is undeclared
// even though all four supported runtimes provide it. Ambient-declare only what is called — the
// same approach `src/deno.ts` takes for the Deno globals. Deliberately *not* `node:crypto`: this
// file is the runtime-neutral core, and the web-standard global is what Deno, Bun and workerd all
// have without a compatibility flag.
declare const crypto: { randomUUID(): string };

/** A runtime-neutral inbound request: body already parsed by the caller's ingress (Node stream, fetch Request, …). */
export interface NeutralRequest {
  method: string;
  url: string; // path + query, e.g. "/users/9?x=1"
  headers: Record<string, string | string[] | undefined>;
  body: unknown; // already-parsed body
  secure: boolean;
  ip: string;
  requestId: string;
  traceId?: string;
}

// Module scope, not a local inside `correlateRequest`. Declared there it was a closure allocated
// on every single request, which measured at 0.16 us against a ~4.4 us one — 45% of the whole
// observability overhead, for a helper that captures nothing.
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * Derives a request's identity from its headers, for the adapters to stamp on a `NeutralRequest`.
 *
 * **Called by the adapters, not by {@link handle}**, and the placement is the point. Both adapters
 * read and size-check the body before they reach `handle()` (`server.ts`, `web.ts`), so a `413` is
 * answered without `handle()` ever seeing the request. Generating identity in here would leave
 * precisely the failures an operator most wants to correlate with nothing to correlate them by.
 *
 * An `x-request-id` from a gateway is adopted rather than replaced — a service behind a proxy must
 * not open a second identity for a request that already has one. `traceparent` is carried through
 * untouched: core implements no propagation spec, and W3C Trace Context belongs to the exporter.
 */
export function correlateRequest(headers: Record<string, string | string[] | undefined>): {
  requestId: string;
  traceId?: string;
} {
  const incoming = first(headers['x-request-id'])?.trim();
  const traceId = first(headers.traceparent)?.trim();

  // Eager, and `randomUUID` rather than something cheaper, both deliberately. A lazy getter is
  // defeated the moment anything spreads this object — which the adapters and the payload builders
  // both do — so it would buy nothing without threading a nested correlation object through the
  // whole request path. And a boot-prefix counter measured 5x cheaper (14.7ns vs 77.1ns) but
  // trades the standard identifier shape for ~1.7% of a real request. Neither is worth its
  // complexity until a profile says otherwise; the expensive part was building payloads for
  // nobody, and `Bus.hasListeners` is what fixed that.
  return { requestId: incoming || crypto.randomUUID(), traceId: traceId || undefined };
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

function errorOutcome(
  error: unknown,
  req: NeutralRequest,
  injected: Record<string, string>,
  opts: HttpOptions | undefined,
  headers: Record<string, string> = {},
): HandleResult {
  const rendered = renderError(error, { method: req.method, url: req.url, headers: req.headers }, opts?.onError);
  return {
    injected,
    outcome: {
      kind: 'buffered',
      status: rendered.status,
      headers: { ...rendered.headers, ...headers },
      body: req.method === 'HEAD' ? '' : rendered.body,
    },
  };
}

async function unmatchedOutcome(
  routes: RouteDef[],
  opts: HttpOptions | undefined,
  req: NeutralRequest,
  path: string,
  injected: Record<string, string>,
): Promise<HandleResult> {
  if ((req.method === 'GET' || req.method === 'HEAD') && opts?.static) {
    const hit = await opts.static(path);

    if (hit) {
      return {
        injected,
        outcome: {
          kind: 'buffered',
          status: 200,
          headers: { 'content-type': hit.contentType },
          body: req.method === 'HEAD' ? '' : hit.body,
        },
      };
    }
  }

  const allow = allowedMethods(routes, path);

  if (req.method === 'OPTIONS' && allow.length) {
    return {
      injected,
      outcome: { kind: 'buffered', status: 204, headers: { allow: allow.join(', ') }, body: '' },
    };
  }

  const error = allow.length ? new HttpError(405, 'Method Not Allowed') : new NotFound('Not Found');
  return errorOutcome(error, req, injected, opts, allow.length ? { allow: allow.join(', ') } : {});
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
  const injected = computeInjected(opts, req);
  let path: string;

  try {
    path = normalizeRequestPath(req.url.split('?')[0]);
  } catch {
    return errorOutcome(new HttpError(400, 'Bad Request'), req, injected, opts);
  }

  if (opts?.cors && req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
    return { preflight: corsPreflightHeaders(opts.cors, req) };
  }

  const matched = resolveRoute(routes, req.method, path);

  if (!matched) return unmatchedOutcome(routes, opts, req, path, injected);

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
      requestId: req.requestId,
      traceId: req.traceId,
    });
  } catch (error) {
    result = renderError(error, { method: req.method, url: req.url, headers: req.headers }, opts?.onError);
  }

  if (isStreamResult(result)) {
    const encoder = pickEncoder(matched.def.transport, String(req.headers.accept ?? ''));
    return { injected, outcome: { kind: 'stream', headers: encoder.headers, stream: result.stream, encoder } };
  }

  return {
    injected,
    outcome: {
      kind: 'buffered',
      status: result.status,
      headers: result.headers,
      body: req.method === 'HEAD' ? '' : result.body,
    },
  };
}
