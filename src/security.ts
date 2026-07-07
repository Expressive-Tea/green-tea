// src/security.ts — pure header computation, no server deps

/** TLS material for an HTTPS server. */
export interface TlsOptions {
  key: Buffer | string;
  cert: Buffer | string;
  ca?: Buffer | string;
  passphrase?: string;
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

function originAllowed(spec: CorsOptions['origins'], origin: string): boolean {
  if (spec === '*') return true;
  if (typeof spec === 'function') return spec(origin);
  if (Array.isArray(spec)) return spec.includes(origin);
  return spec === origin;
}

/** Compute CORS response headers for a request. Returns `{}` when the origin is not allowed. */
export function resolveCors(
  opts: CorsOptions,
  req: { headers: Record<string, string | string[] | undefined> },
): Headers {
  const headers: Headers = {};
  const rawOrigin = req.headers['origin'];
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (!origin || !isValidOrigin(origin) || !originAllowed(opts.origins, origin)) return headers;

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
): Headers {
  const headers = resolveCors(opts, req);
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
