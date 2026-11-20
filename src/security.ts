// src/security.ts — pure header computation, no server deps

import type { Logger } from './logger';

/** TLS material for an HTTPS server. */
export interface TlsOptions {
  key: Buffer | string;
  cert: Buffer | string;
  ca?: Buffer | string;
  passphrase?: string;
}

/**
 * Set on an app created with `tls`, so the adapters that serve through their runtime's own listener
 * (`serveDeno`, `serveBun`) can refuse it. Only Node's `listen()` reads `tls`; anywhere else it would
 * serve plain HTTP to someone who asked for HTTPS. Symbol-keyed because it is adapter plumbing.
 */
export const TLS_REQUESTED: unique symbol = Symbol.for('green-tea.tls-requested');

/** Throws when `app` was created with `tls`, which `adapter` cannot honour. */
export function refuseTls(app: object, adapter: string): void {
  if ((app as { [TLS_REQUESTED]?: boolean })[TLS_REQUESTED]) {
    throw new Error(
      `${adapter} does not support createApp({ tls }); it would serve plain HTTP. ` +
        `Configure TLS on the runtime's own server or terminate it at a proxy, and drop \`tls\`.`,
    );
  }
}

/**
 * Set on an app created with `mesh`, so `edgeHandler` can refuse it (#87). Mesh does not run on the
 * edge: the teapot's secret check needs `node:crypto`'s `timingSafeEqual`, which `nodejs_compat`
 * lacks, and a teacup's links are long-lived outbound sockets a Worker cannot hold. Without this the
 * app booted and failed later, somewhere else. Symbol-keyed because it is adapter plumbing.
 */
export const MESH_REQUESTED: unique symbol = Symbol.for('green-tea.mesh-requested');

/** The one message for mesh on the edge, from `createApp` (detected) or `edgeHandler` (explicit). */
export const MESH_ON_EDGE =
  'mesh does not run on the edge (Cloudflare Workers): the teapot needs node:crypto timingSafeEqual and ' +
  'a teacup needs long-lived outbound sockets. Run mesh nodes on Node, Deno or Bun, and drop `mesh` here.';

/** Throws when `app` was created with `mesh` (#87). */
export function refuseMeshOnEdge(app: object): void {
  if ((app as { [MESH_REQUESTED]?: boolean })[MESH_REQUESTED]) throw new Error(MESH_ON_EDGE);
}

/**
 * Set on every app to the function the fetch adapters (`serveDeno`, `serveBun`, `edgeHandler`) call
 * before they accept a WebSocket upgrade: `(origin, host, path) => allowed`. Symbol-keyed because it
 * is adapter plumbing; see {@link wsOriginAllowed} and {@link refuseWsOrigin}.
 */
export const WS_ORIGIN_CHECK: unique symbol = Symbol.for('green-tea.ws-origin-check');

/**
 * Whether a WebSocket upgrade from `origin` may be accepted (GHSA-p697-fpqx-pgf3).
 *
 * A browser attaches the site's cookies to an upgrade started by any page, and CORS does not apply to
 * WebSockets, so without this check a page on another site could open a socket as the signed-in user
 * (cross-site WebSocket hijacking). Allowed: no `Origin` at all (not a browser), the same host the
 * request was sent to, or an origin `cors.origins` allows. Everything else, `null` included, is refused.
 */
export function wsOriginAllowed(
  origin: string | null | undefined,
  host: string | null | undefined,
  cors?: CorsOptions,
  logger?: Logger,
): boolean {
  if (!origin) return true;
  if (!isValidOrigin(origin)) return false;

  try {
    if (host && new URL(origin).host === host.toLowerCase()) return true;
  } catch {
    return false;
  }

  return cors ? originAllowed(cors.origins, origin, logger) : false;
}

/** For the fetch adapters: a `403` to return instead of upgrading, or `undefined` to go ahead. */
export function refuseWsOrigin(app: object, request: Request): Response | undefined {
  const check = (app as { [WS_ORIGIN_CHECK]?: (origin: string | null, host: string, path: string) => boolean })[
    WS_ORIGIN_CHECK
  ];
  const url = new URL(request.url);

  // The URL's host, not the `Host` header: Deno and Bun build the URL from that header anyway, and on
  // the edge the URL is the one the client asked for while `Host` may name an internal hop.
  if (!check || check(request.headers.get('origin'), url.host, url.pathname)) {
    return undefined;
  }

  return new Response('Forbidden', { status: 403 });
}

/**
 * Refuses `cors: { origins: '*', credentials: true }` at boot (GHSA-fccm-q62j-48hr). The spec forbids
 * `*` with credentials, so the only way to honour both was to echo every origin, `null` included, with
 * `Access-Control-Allow-Credentials: true`: any site could then make credentialed reads. An app that
 * really means that writes it as a predicate, where it is visible.
 */
export function assertCorsOptions(cors: CorsOptions | undefined): void {
  if (cors?.origins === '*' && cors.credentials) {
    throw new Error(
      "cors: { origins: '*', credentials: true } would let every site make credentialed requests. " +
        'List the origins you trust, or pass a predicate such as `origins: (origin) => origin.endsWith(".example.com")`.',
    );
  }
}

/** CORS policy. `origins` may be a literal, list, `'*'`, or a predicate. */
export interface CorsOptions {
  origins: string | string[] | '*' | ((origin: string) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/** Security header policy. Each field toggles or configures one response header. */
export interface SecurityOptions {
  hsts?: boolean | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };
  frameOptions?: 'SAMEORIGIN' | 'DENY' | false;
  referrerPolicy?: string | false;
  noSniff?: boolean;
  dnsPrefetchControl?: boolean;
  csp?: string;
}

type Headers = Record<string, string>;
const HSTS_DEFAULT_MAXAGE = 15552000; // 180 days

// scheme "://" host [":" port], or literal "null". Rejects control chars/whitespace.
// Control-char ranges (\x00-\x1f\x7f) are intentional: reject control chars in Origin headers.
// eslint-disable-next-line no-control-regex
const ORIGIN_RE = /^(?:null|[a-z][a-z0-9+.-]*:\/\/[^\s/?#\x00-\x1f\x7f]+)$/i;

/** True if `origin` is a well-formed Origin header value (scheme://host or literal `null`). */
export function isValidOrigin(origin: string): boolean {
  return ORIGIN_RE.test(origin);
}

/** Append `add` to a `Vary` header value, case-insensitively deduplicated. */
export function mergeVary(existing: string | undefined, add: string): string {
  const parts = existing
    ? existing
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean)
    : [];
  if (!parts.some((part) => part.toLowerCase() === add.toLowerCase())) parts.push(add);
  return parts.join(', ');
}

/** Build security response headers (HSTS, frame options, CSP, etc.). `secure` gates HSTS. */
export function buildSecurityHeaders(opts: boolean | SecurityOptions, secure: boolean): Headers {
  if (opts === false) return {};
  const options: SecurityOptions = opts === true ? {} : opts;
  const headers: Headers = {};
  if (options.noSniff !== false) headers['x-content-type-options'] = 'nosniff';
  if (options.frameOptions !== false) headers['x-frame-options'] = options.frameOptions ?? 'SAMEORIGIN';
  if (options.referrerPolicy !== false) headers['referrer-policy'] = options.referrerPolicy ?? 'no-referrer';
  if (options.dnsPrefetchControl !== false) headers['x-dns-prefetch-control'] = 'off';
  if (options.csp) headers['content-security-policy'] = options.csp;

  if (secure && options.hsts !== false) {
    const hsts = options.hsts && options.hsts !== true ? options.hsts : {};
    let value = `max-age=${hsts.maxAge ?? HSTS_DEFAULT_MAXAGE}`;
    if (hsts.includeSubDomains) value += '; includeSubDomains';
    if (hsts.preload) value += '; preload';
    headers['strict-transport-security'] = value;
  }

  return headers;
}

function originAllowed(spec: CorsOptions['origins'], origin: string, logger?: Logger): boolean {
  if (spec === '*') return true;
  if (Array.isArray(spec)) return spec.includes(origin);
  if (typeof spec !== 'function') return spec === origin;

  // The predicate is user code on the request path — a Redis allowlist, a tenant lookup — and it runs
  // before the region where errors convert to a response, so a throw here would leave the request
  // listener as an unhandled rejection and take the process down. Deny instead: a lookup that failed
  // has not said yes, and a broken allowlist must never widen into an open one.
  try {
    return spec(origin);
  } catch (error) {
    logger?.warn(`cors: the origins predicate threw for ${origin} — treating the origin as not allowed`, {
      origin,
      err: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Compute CORS response headers for a request. Returns `{}` when the origin is not allowed. */
export function resolveCors(
  opts: CorsOptions,
  req: { headers: Record<string, string | string[] | undefined> },
  logger?: Logger,
): Headers {
  const headers: Headers = {};
  const rawOrigin = req.headers['origin'];
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (!origin || !isValidOrigin(origin) || !originAllowed(opts.origins, origin, logger)) return headers;

  // credentials => never '*'; echo concrete origin. Also echo when allowlist is dynamic.
  if (opts.credentials) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-credentials'] = 'true';
    headers['vary'] = mergeVary(headers['vary'], 'Origin');
  } else if (opts.origins === '*') {
    headers['access-control-allow-origin'] = '*';
  } else {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = mergeVary(headers['vary'], 'Origin');
  }

  if (opts.exposedHeaders?.length) headers['access-control-expose-headers'] = opts.exposedHeaders.join(', ');
  return headers;
}

/** Preflight-specific headers (methods/allowed-headers/max-age). Call only for OPTIONS+ACRM. */
export function corsPreflightHeaders(
  opts: CorsOptions,
  req: { headers: Record<string, string | string[] | undefined> },
  resolved?: Headers,
): Headers {
  // The caller has almost always resolved CORS already, one layer up, to seed the headers every
  // response carries. Re-deriving here would consult `origins` a second time for the same request —
  // and `origins` may be a predicate doing a network lookup. Copied rather than used in place: the
  // preflight-only keys below belong to this 204, not to the shared object.
  const headers: Headers = { ...resolved };
  if (!headers['access-control-allow-origin']) return headers; // origin not allowed → bare 204
  headers['access-control-allow-methods'] = (opts.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).join(
    ', ',
  );
  const requestedHeaders = req.headers['access-control-request-headers'];
  headers['access-control-allow-headers'] =
    opts.allowedHeaders?.join(', ') ??
    (Array.isArray(requestedHeaders) ? requestedHeaders.join(', ') : (requestedHeaders ?? '*'));
  if (opts.maxAge != null) headers['access-control-max-age'] = String(opts.maxAge);
  return headers;
}
