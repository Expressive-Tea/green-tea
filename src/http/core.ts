// src/http/core.ts — runtime-neutral request handling core, shared by the Node adapter and (later) app.fetch.
import { HttpError, NotFound } from '../signals';
import { renderError } from '../transformers';
import { isStreamResult, type PipelineResult } from '../pipeline';
import { buildSecurityHeaders, resolveCors, corsPreflightHeaders } from '../security';
import { resolveRoute, allowedMethods, normalizeRequestPath, parseQuery } from './router';
import { pickEncoder } from './stream';
import type { RouteDef, HttpOptions } from './types';
import type { StreamEncoder } from '../encoders';
import type { Bus } from '../bus';

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

  // `randomUUID` is not the lazy choice here, it is the measured one. Every supported runtime
  // already batches entropy behind it, so the obvious "faster" replacements are not:
  //
  //   crypto.randomUUID()                       76 ns
  //   batched getRandomValues + hex, 12 bytes   50 ns   cross-runtime, saves 0.26% of a request
  //   batched + Buffer.toString('hex')          49 ns   Node-only, so it cannot be used here
  //   uint32 -> toString(36) from a pool       114 ns
  //   Math.random() x2 -> base36               265 ns   3.5x SLOWER; string work dominates
  //   getRandomValues per call, unbatched      472 ns
  //
  // The only cross-runtime win is 26 ns, against ~10.19 us for a real socketed request. A hand-
  // rolled entropy pool is not worth 0.26%. A lazy getter is separately useless: the adapters and
  // the payload builders both spread this object, and the first spread materialises it.
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

/** What `dispatch` learned along the way that `handle` needs in order to describe the request afterwards. */
interface Trace {
  route?: string;
}

/**
 * Runtime-neutral request handler: security/CORS headers, preflight short-circuit, route match / 404 / 405,
 * route-handler invocation with error rendering, and the buffered-vs-stream decision. Does no I/O — the
 * caller (a Node adapter, a fetch adapter, …) reads/writes the actual request/response.
 *
 * Wraps {@link dispatch} with the request-level lifecycle events. `request:end` fires when the handler
 * returns, **not** when a stream it produced finishes: a route that returns an `AsyncIterable` is done
 * here in milliseconds while its connection may live for hours, and ending the span at close would put
 * hour-long SSE connections and 2 ms buffered replies in one latency distribution, ruining both.
 * `stream:open`/`stream:close` already describe the connection, and now carry the same `requestId`.
 */
export function handle(
  routes: RouteDef[],
  opts: HttpOptions | undefined,
  req: NeutralRequest,
): Promise<HandleResult | Preflight> {
  const bus = opts?.bus;

  // Deliberately not `async`. Wrapping `dispatch` in a second async frame costs a promise and two
  // microtask ticks per request — measured at 0.43 us, an order of magnitude more than the four
  // Map lookups this branch avoids. An unobserved app returns dispatch's own promise untouched.
  if (
    bus === undefined ||
    !(
      bus.hasListeners('request:start') ||
      bus.hasListeners('request:end') ||
      bus.hasListeners('route:matched') ||
      bus.hasListeners('route:unmatched')
    )
  ) {
    return dispatch(routes, opts, req, undefined, undefined);
  }

  return observedDispatch(routes, opts, req, bus);
}

async function observedDispatch(
  routes: RouteDef[],
  opts: HttpOptions | undefined,
  req: NeutralRequest,
  bus: Bus,
): Promise<HandleResult | Preflight> {
  const watchingEnd = bus.hasListeners('request:end');
  const startedAt = watchingEnd ? performance.now() : 0;
  const trace: Trace = {};

  if (bus.hasListeners('request:start'))
    bus.emit('request:start', {
      name: `${req.method} ${req.url}`,
      method: req.method,
      requestId: req.requestId,
      traceId: req.traceId,
    });

  const result = await dispatch(routes, opts, req, bus, trace);

  if (watchingEnd) {
    // A preflight is a 204 the router never routed; a stream has no status of its own and is a 200
    // by the time anything is piped.
    const status = 'preflight' in result ? 204 : result.outcome.kind === 'buffered' ? result.outcome.status : 200;
    bus.emit('request:end', {
      name: trace.route ?? `${req.method} ${req.url}`,
      method: req.method,
      route: trace.route,
      status,
      durationMs: performance.now() - startedAt,
      requestId: req.requestId,
      traceId: req.traceId,
    });
  }

  return result;
}

async function dispatch(
  routes: RouteDef[],
  opts: HttpOptions | undefined,
  req: NeutralRequest,
  bus: Bus | undefined,
  trace: Trace | undefined,
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

  if (!matched) {
    if (bus?.hasListeners('route:unmatched'))
      bus.emit('route:unmatched', {
        name: `${req.method} ${path}`,
        method: req.method,
        requestId: req.requestId,
        traceId: req.traceId,
      });

    return unmatchedOutcome(routes, opts, req, path, injected);
  }

  if (trace) trace.route = matched.def.pattern;

  if (bus?.hasListeners('route:matched'))
    bus.emit('route:matched', {
      name: matched.def.pattern,
      route: matched.def.pattern,
      method: req.method,
      transport: matched.def.transport,
      requestId: req.requestId,
      traceId: req.traceId,
    });

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
