// src/cookies.ts — request cookie parsing and `Set-Cookie` serialisation (RFC 6265), dependency-free.

/**
 * Options for {@link setCookie}. Every attribute is optional; the defaults are the safe ones
 * (`httpOnly: true`, `sameSite: 'lax'`, `path: '/'`, `secure: true`).
 */
export interface CookieOptions {
  /** `Max-Age` in seconds. An integer; `0` or a negative value tells the browser to drop the cookie. */
  maxAge?: number;
  /** `Expires`, written as an HTTP date. `maxAge` wins in browsers when both are set. */
  expires?: Date;
  /** `Path`. Default `'/'`. */
  path?: string;
  /** `Domain`. Omitted by default, which scopes the cookie to the exact host that set it. */
  domain?: string;
  /**
   * `Secure`. Default `true`: Chrome, Edge and Firefox accept a `Secure` cookie on
   * `http://localhost`. Safari, a LAN IP or a plain-HTTP dev hostname do not — pass `false` there
   * (for example `secure: !isDev`).
   */
  secure?: boolean;
  /** `HttpOnly`. Default `true`, so page scripts cannot read the cookie. */
  httpOnly?: boolean;
  /** `SameSite`. Default `'lax'`. `'none'` requires `secure`. */
  sameSite?: 'strict' | 'lax' | 'none';
  /** `Partitioned` (CHIPS). Requires `secure`. */
  partitioned?: boolean;
}

/** RFC 6265 §4.1.1 cookie-name: an RFC 7230 token. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** What a cookie value may not contain: CR, LF, `;`, `,`, whitespace and every control character. */
// eslint-disable-next-line no-control-regex
const BAD_VALUE = /[\u0000- ;,\u007f]/;
/**
 * What an attribute value may not contain. CR/LF is the header-injection case the card names; `;`
 * and the other control characters are refused too, because a `;` inside `Path` would start a new
 * attribute and change what the cookie means without breaking the header.
 */
// eslint-disable-next-line no-control-regex
const BAD_ATTRIBUTE = /[\u0000-\u001f;\u007f]/;

const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None' } as const;

/**
 * Serialises one `Set-Cookie` header value.
 *
 * Throws, naming the field, rather than producing a header that would split or reshape the
 * response: a name outside the RFC 6265 token set, a value carrying CR, LF, `;`, `,`, whitespace or a
 * control character, an attribute carrying CR/LF, `;` or a control character, a non-integer
 * `maxAge`, an invalid `expires`, and `sameSite: 'none'` or `partitioned` without `secure`.
 *
 * The value is written as given. Encode it yourself (`encodeURIComponent`) if it can hold any of the
 * refused characters; the cookie decorators decode `%`-sequences on the way back in.
 *
 * Several cookies on one response go in an array: `headers: { 'set-cookie': [a, b] }`, and each
 * element is sent as its own `Set-Cookie` line on every adapter.
 *
 * @example
 * setCookie('session', id, { maxAge: 3600 })
 * // 'session=<id>; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Lax'
 */
export function setCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (typeof name !== 'string' || !TOKEN.test(name))
    throw new TypeError(`setCookie: name ${JSON.stringify(name)} is not a valid cookie name (RFC 6265 token)`);

  if (typeof value !== 'string' || BAD_VALUE.test(value))
    throw new TypeError(
      `setCookie: value for '${name}' contains a character a cookie value cannot carry (CR, LF, ';', ',', whitespace or a control character)`,
    );

  const secure = options.secure ?? true;
  const sameSite = options.sameSite ?? 'lax';
  const parts = [`${name}=${value}`];

  if (options.maxAge !== undefined) {
    if (!Number.isInteger(options.maxAge)) throw new TypeError(`setCookie: maxAge for '${name}' must be an integer`);
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires !== undefined) {
    if (!(options.expires instanceof Date) || Number.isNaN(options.expires.getTime()))
      throw new TypeError(`setCookie: expires for '${name}' must be a valid Date`);
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }

  if (options.domain !== undefined) parts.push(`Domain=${attribute(name, 'domain', options.domain)}`);
  parts.push(`Path=${attribute(name, 'path', options.path ?? '/')}`);
  if (secure) parts.push('Secure');
  if (options.httpOnly ?? true) parts.push('HttpOnly');

  if (!Object.prototype.hasOwnProperty.call(SAME_SITE, sameSite))
    throw new TypeError(`setCookie: sameSite for '${name}' must be 'strict', 'lax' or 'none'`);

  if (sameSite === 'none' && !secure)
    throw new TypeError(`setCookie: sameSite 'none' for '${name}' requires secure (browsers reject it otherwise)`);
  parts.push(`SameSite=${SAME_SITE[sameSite]}`);

  if (options.partitioned) {
    if (!secure) throw new TypeError(`setCookie: partitioned for '${name}' requires secure`);
    parts.push('Partitioned');
  }

  return parts.join('; ');
}

function attribute(name: string, field: string, value: string): string {
  if (typeof value !== 'string' || value === '' || BAD_ATTRIBUTE.test(value))
    throw new TypeError(
      `setCookie: ${field} for '${name}' must be a non-empty string without CR, LF, ';' or control characters`,
    );
  return value;
}

/**
 * Parses a request `Cookie` header into a name → value map (RFC 6265 §5.2 / §4.2).
 *
 * - The first value wins for a repeated name — the browser sends the most specific cookie first.
 * - `%`-sequences are decoded; a value that fails to decode is kept raw rather than rejected.
 * - A malformed pair (no `=`, or an empty name) is skipped. A broken cookie never becomes a 400:
 *   the header is client state the server did not choose and the request may not even need it.
 * - Several `cookie` lines (HTTP/2, some proxies) arrive as an array and are joined with `; `.
 *
 * The map has no prototype, so a cookie named `__proto__` or `constructor` is just a key.
 */
export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (header === undefined) return out;
  const raw = Array.isArray(header) ? header.join('; ') : header;

  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (key === '' || key in out) continue;
    out[key] = decode(pair.slice(eq + 1).trim());
  }

  return out;
}

function decode(value: string): string {
  if (!value.includes('%')) return value;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
