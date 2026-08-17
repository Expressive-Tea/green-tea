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
        handlerVary = handlerHeaders[key];
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
