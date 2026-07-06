// src/security.ts — pure header computation, no server deps
export interface TlsOptions { key: Buffer | string; cert: Buffer | string; ca?: Buffer | string; passphrase?: string }

export interface CorsOptions {
  origins: string | string[] | '*' | ((origin: string) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

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
const ORIGIN_RE = /^(?:null|[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+)$/i;
export function isValidOrigin(o: string): boolean { return ORIGIN_RE.test(o); }

export function mergeVary(existing: string | undefined, add: string): string {
  const parts = (existing ? existing.split(',').map((s) => s.trim()).filter(Boolean) : []);
  if (!parts.some((p) => p.toLowerCase() === add.toLowerCase())) parts.push(add);
  return parts.join(', ');
}

export function buildSecurityHeaders(opts: boolean | SecurityOptions, secure: boolean): Headers {
  if (opts === false) return {};
  const o: SecurityOptions = opts === true ? {} : opts;
  const h: Headers = {};
  if (o.noSniff !== false) h['x-content-type-options'] = 'nosniff';
  if (o.frameOptions !== false) h['x-frame-options'] = o.frameOptions ?? 'SAMEORIGIN';
  if (o.referrerPolicy !== false) h['referrer-policy'] = o.referrerPolicy ?? 'no-referrer';
  if (o.dnsPrefetchControl !== false) h['x-dns-prefetch-control'] = 'off';
  if (o.csp) h['content-security-policy'] = o.csp;
  if (secure && o.hsts !== false) {
    const hs = o.hsts && o.hsts !== true ? o.hsts : {};
    let v = `max-age=${hs.maxAge ?? HSTS_DEFAULT_MAXAGE}`;
    if (hs.includeSubDomains) v += '; includeSubDomains';
    if (hs.preload) v += '; preload';
    h['strict-transport-security'] = v;
  }
  return h;
}

function originAllowed(spec: CorsOptions['origins'], origin: string): boolean {
  if (spec === '*') return true;
  if (typeof spec === 'function') return spec(origin);
  if (Array.isArray(spec)) return spec.includes(origin);
  return spec === origin;
}

// req: minimal shape { headers: { origin? } }
export function resolveCors(opts: CorsOptions, req: { headers: Record<string, string | string[] | undefined> }): Headers {
  const h: Headers = {};
  const raw = req.headers['origin'];
  const origin = Array.isArray(raw) ? raw[0] : raw;
  if (!origin || !isValidOrigin(origin) || !originAllowed(opts.origins, origin)) return h;

  // credentials => never '*'; echo concrete origin. Also echo when allowlist is dynamic.
  if (opts.credentials) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-credentials'] = 'true';
    h['vary'] = mergeVary(h['vary'], 'Origin');
  } else if (opts.origins === '*') {
    h['access-control-allow-origin'] = '*';
  } else {
    h['access-control-allow-origin'] = origin;
    h['vary'] = mergeVary(h['vary'], 'Origin');
  }
  if (opts.exposedHeaders?.length) h['access-control-expose-headers'] = opts.exposedHeaders.join(', ');
  return h;
}

// Preflight-specific headers (methods/allowed-headers/max-age). Call only for OPTIONS+ACRM.
export function corsPreflightHeaders(opts: CorsOptions, req: { headers: Record<string, string | string[] | undefined> }): Headers {
  const h = resolveCors(opts, req);
  if (!h['access-control-allow-origin']) return h; // origin not allowed → bare 204
  h['access-control-allow-methods'] = (opts.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).join(', ');
  const reqHdrs = req.headers['access-control-request-headers'];
  h['access-control-allow-headers'] = opts.allowedHeaders?.join(', ')
    ?? (Array.isArray(reqHdrs) ? reqHdrs.join(', ') : reqHdrs ?? '*');
  if (opts.maxAge != null) h['access-control-max-age'] = String(opts.maxAge);
  return h;
}
