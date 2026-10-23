// src/http/conditional.ts — ETags and conditional GET (RFC 9110 §8.8.3, §13.1.2, §13.1.3, §15.4.5).

type HeaderBag = Record<string, string | string[] | undefined>;

/** The first value of a request header, or `undefined`. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Splits an `If-None-Match` list on the commas that sit outside quotes. An entity-tag may legally
 * contain a comma inside its quotes (`"a,b"`), so a plain `split(',')` would cut one tag in two.
 */
function splitTags(header: string): string[] {
  const tags: string[] = [];
  let start = 0;
  let quoted = false;

  for (let i = 0; i < header.length; i++) {
    const ch = header[i];

    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      tags.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }

  tags.push(header.slice(start).trim());
  return tags.filter(Boolean);
}

/** The opaque part of an entity-tag: `W/"x"` and `"x"` both become `"x"` (weak comparison). */
const opaque = (tag: string): string => (tag.startsWith('W/') ? tag.slice(2) : tag);

/**
 * Whether `If-None-Match` matches `etag` under the weak comparison GET and HEAD use
 * (RFC 9110 §13.1.2): `W/"x"` matches `"x"`, and `*` matches any current representation.
 */
export function ifNoneMatchMatches(header: string, etag: string): boolean {
  const own = opaque(etag.trim());

  for (const tag of splitTags(header)) if (tag === '*' || opaque(tag) === own) return true;

  return false;
}

/**
 * Whether a resource last modified at `mtimeMs` is unchanged since an `If-Modified-Since` date.
 * HTTP dates have one-second resolution, so the modification time is truncated to the second first;
 * otherwise a file written at 12:00:00.400 would never match the `Last-Modified` it was served with.
 * An unparseable date is ignored, as RFC 9110 §13.1.3 requires.
 */
export function notModifiedSince(header: string, mtimeMs: number): boolean {
  const since = Date.parse(header);
  if (Number.isNaN(since)) return false;
  return Math.floor(mtimeMs / 1000) * 1000 <= since;
}

/**
 * Decides a conditional GET/HEAD: `If-None-Match` when present, else `If-Modified-Since` when the
 * caller has a modification time to compare (static files only — handler responses have none).
 */
export function isNotModified(headers: HeaderBag, etag: string, mtimeMs?: number): boolean {
  const inm = single(headers['if-none-match']);
  if (inm !== undefined) return ifNoneMatchMatches(inm, etag);

  const ims = single(headers['if-modified-since']);
  return ims !== undefined && mtimeMs !== undefined && notModifiedSince(ims, mtimeMs);
}

/** Weak validator for a static file, from the `stat` the resolver already does: `W/"<size>-<mtimeMs base36>"`. */
export function staticEtag(size: number, mtimeMs: number): string {
  return `W/"${size}-${Math.floor(mtimeMs).toString(36)}"`;
}

/**
 * Weak validator for a buffered body: its byte length plus a 32-bit FNV-1a hash of its bytes, in
 * base 36. FNV rather than `crypto.subtle.digest`: it is synchronous and dependency-free, where
 * `subtle` costs a promise per response. It is not collision-resistant and need not be — an ETag
 * detects change, it does not authenticate. The length narrows a collision to equal-length bodies.
 *
 * Weak, so one tag can describe every content-coding of the same body (CARD-16 hashes before it
 * encodes). Strings are hashed as UTF-8, so the tag matches what goes on the wire.
 */
export function bodyEtag(body: string | Uint8Array): string {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  let hash = 0x811c9dc5;

  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }

  return `W/"${bytes.length.toString(36)}-${(hash >>> 0).toString(36)}"`;
}

/** The key under which `headers` holds `name`, case-insensitively, or `undefined`. */
export function findHeader(headers: Record<string, unknown>, name: string): string | undefined {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) return key;
  return undefined;
}

/**
 * The headers of a `304` built from the `200` it stands for: everything but the `content-*`
 * headers that describe a body (`content-type`, `content-length`, `content-encoding`, …), plus
 * `transfer-encoding`. `content-location` is kept: §15.4.5 lists it among the fields a 304 sends. `ETag`, `Vary`, `Cache-Control`, `Last-Modified` and anything else a cache
 * would update stay (RFC 9110 §15.4.5). Injected security headers are merged later by the adapter,
 * exactly as on a `200`.
 */
export function notModifiedHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};

  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if ((lower.startsWith('content-') && lower !== 'content-location') || lower === 'transfer-encoding') continue;
    out[key] = headers[key];
  }

  return out;
}
