import { mergeVary } from '../security';

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
  const injectedLower = new Set(Object.keys(injected).map((key) => key.toLowerCase()));
  let handlerVary: string | undefined;

  if (handlerHeaders)
    for (const key of Object.keys(handlerHeaders)) {
      const lowerKey = key.toLowerCase();

      if (lowerKey === 'vary') {
        handlerVary = handlerHeaders[key];
        continue;
      }

      if (!injectedLower.has(lowerKey)) merged[key] = handlerHeaders[key];
    }

  Object.assign(merged, injected);
  if (injected['vary']) merged['vary'] = mergeVary(handlerVary, injected['vary']);
  else if (handlerVary !== undefined) merged['vary'] = handlerVary;
  return merged;
}
