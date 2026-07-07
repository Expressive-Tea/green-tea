import type { RouteDef, MatchedRoute } from './types';

/**
 * Matches a route pattern against a request path. Supports static segments, `:param` (one segment),
 * and a trailing `:name*` catch-all that captures the rest of the path (slashes included) into `params.name`.
 * @returns Extracted params (decoded) when the path matches, otherwise undefined.
 */
export function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  const pathSegs = path.split('/').filter(Boolean);
  const patternSegs = pattern.split('/').filter(Boolean);
  const params: Record<string, string> = {};

  for (let i = 0; i < patternSegs.length; i++) {
    const seg = patternSegs[i];

    // Trailing catch-all: capture every remaining segment (possibly none) as one decoded value.
    if (seg.startsWith(':') && seg.endsWith('*')) {
      params[seg.slice(1, -1)] = pathSegs.slice(i).map(decodeURIComponent).join('/');
      return params;
    }

    if (i >= pathSegs.length) return undefined; // pattern longer than path

    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(pathSegs[i]);
    else if (seg !== pathSegs[i]) return undefined;
  }

  // No catch-all consumed the tail, so the lengths must match exactly.
  return patternSegs.length === pathSegs.length ? params : undefined;
}

/** Splits a pattern into its fixed-prefix segment kinds (2 = static, 1 = param) and whether it ends in a catch-all. */
function segScores(pattern: string): { catchAll: boolean; kinds: number[] } {
  const kinds: number[] = [];

  for (const seg of pattern.split('/').filter(Boolean)) {
    if (seg.startsWith(':') && seg.endsWith('*')) return { catchAll: true, kinds };
    kinds.push(seg.startsWith(':') ? 1 : 2);
  }

  return { catchAll: false, kinds };
}

/** Orders two matching patterns by specificity: exact beats catch-all, then static beats param, then longer wins. */
function moreSpecific(a: string, b: string): number {
  const scoreA = segScores(a);
  const scoreB = segScores(b);
  if (scoreA.catchAll !== scoreB.catchAll) return scoreA.catchAll ? -1 : 1;
  const length = Math.max(scoreA.kinds.length, scoreB.kinds.length);

  for (let i = 0; i < length; i++) {
    const kindA = scoreA.kinds[i] ?? -1;
    const kindB = scoreB.kinds[i] ?? -1;
    if (kindA !== kindB) return kindA - kindB;
  }

  return 0;
}

/** Finds the most specific route matching both method and path (static > param > catch-all; ties keep registration order). */
export function matchRoute(routes: RouteDef[], method: string, path: string): MatchedRoute | undefined {
  let best: MatchedRoute | undefined;
  let bestPattern = '';

  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPattern(route.pattern, path);
    if (!params) continue;

    if (!best || moreSpecific(route.pattern, bestPattern) > 0) {
      best = { params, def: route };
      bestPattern = route.pattern;
    }
  }

  return best;
}

/** Lists the distinct HTTP methods whose pattern matches the path — used to build a 405 `Allow` header. */
export function allowedMethods(routes: RouteDef[], path: string): string[] {
  const methods = new Set<string>();
  for (const route of routes) if (matchPattern(route.pattern, path)) methods.add(route.method);
  return [...methods];
}

/** Parses a URL's query string into a flat string map (last value wins for repeated keys). */
export function parseQuery(url: string): Record<string, string> {
  const queryString = url.split('?')[1] ?? '';
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(queryString)) out[key] = value;
  return out;
}
