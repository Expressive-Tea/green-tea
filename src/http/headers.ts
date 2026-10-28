import { mergeVary } from '../security';

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Merges a handler's response headers with authoritative `injected` headers
 * (security + CORS). Injected keys win case-insensitively; `vary` is merged.
 * Extracted from the Node writeHead patch so app.fetch shares the exact logic.
 */
export function mergeInjectedHeaders(
  handlerHeaders: Record<string, any> | undefined,
  injected: Record<string, string>,
): Record<string, any> {
  const merged: Record<string, any> = {};
  let handlerVary: string | undefined;

  if (handlerHeaders)
    for (const key of Object.keys(handlerHeaders)) {
      const lowerKey = key.toLowerCase();

      if (lowerKey === 'vary') {
        // A header value may be an array (D11). `mergeVary` splits on commas, so joining first keeps
        // every token a handler listed instead of stringifying the array by accident.
        const value = handlerHeaders[key];
        handlerVary = Array.isArray(value) ? value.join(', ') : value;
        continue;
      }

      // `injected` is looked up directly instead of through a lowercased Set rebuilt per response.
      // Every key it can hold is written as a lowercase literal in `src/security.ts` — both
      // `buildSecurityHeaders` and `resolveCors`, which are its only sources — so lowercasing them
      // again produced a copy of the keys it already had. Three allocations per response (an array,
      // a mapped array, a Set) to answer a question the object answers itself: 146.4 ns against
      // 55.9 ns.
      //
      // `hasOwnProperty` rather than `in`: a handler is free to send a header called `constructor`
      // or `toString`, and `in` would find those on Object.prototype and silently drop them.
      if (!hasOwn.call(injected, lowerKey)) merged[key] = handlerHeaders[key];
    }

  Object.assign(merged, injected);
  if (injected['vary']) merged['vary'] = mergeVary(handlerVary, injected['vary']);
  else if (handlerVary !== undefined) merged['vary'] = handlerVary;
  return merged;
}

/**
 * Prepares merged headers for Node's `writeHead`, which writes one header line per array element
 * for *any* header. That is right for `set-cookie`, the one header whose values cannot be
 * comma-joined (an `Expires` date carries a comma), and wrong for every other: RFC 9110 §5.3 makes a
 * list header's repeated lines equivalent to one comma-joined line, and joining keeps all four
 * adapters sending the same bytes. So every other array is joined with `, ` here, before
 * `writeHead`. Returns the input untouched when it holds no array, which is nearly every response.
 */
export function joinListHeaders<T extends Record<string, unknown>>(headers: T): T {
  let out: Record<string, unknown> | undefined;

  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (!Array.isArray(value) || key.toLowerCase() === 'set-cookie') continue;
    out ??= { ...headers };
    out[key] = value.join(', ');
  }

  return (out as T | undefined) ?? headers;
}

/**
 * Builds a web `Headers` from merged headers. A plain record cannot be handed to `new Response`:
 * the Fetch spec stringifies an array value to `a,b`, which for `set-cookie` is one broken cookie.
 * `set-cookie` elements are appended one by one, so each reaches the client as its own line;
 * every other array is joined with `, `, exactly as {@link joinListHeaders} does for Node.
 *
 * A record of plain strings, which is nearly every response, is returned untouched: Deno and Bun
 * build their native headers from a record directly, and filling a `Headers` from JS instead measured
 * 5–8% on every Deno request.
 */
export function toWebHeaders(headers: Record<string, unknown>): Headers | Record<string, string> {
  if (Object.values(headers).every((value) => typeof value === 'string')) return headers as Record<string, string>;

  const out = new Headers();

  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (value === undefined) continue;

    if (!Array.isArray(value)) out.set(key, String(value));
    else if (key.toLowerCase() === 'set-cookie') for (const cookie of value) out.append(key, String(cookie));
    else out.set(key, value.join(', '));
  }

  return out;
}
