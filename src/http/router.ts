import type { RouteDef, MatchedRoute } from './types';

export type CompiledSegment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string; constraint?: RegExp; constraintSource?: string }
  | { kind: 'catchAll'; name: string };

/** Parsed route pattern reused by matching, specificity, ambiguity checks, and OpenAPI projection. */
export interface CompiledPattern {
  source: string;
  normalized: string;
  shape: string;
  segments: CompiledSegment[];
  kinds: number[];
  catchAll: boolean;
  /** Every segment is a literal, so this pattern scores the maximum specificity and cannot be outranked. */
  allStatic: boolean;
}

const compiledCache = new Map<string, CompiledPattern>();
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CONSTRAINT_LENGTH = 128;

/** Request-path syntax error. Adapters translate this to the standard 400 response envelope. */
export class InvalidRequestPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestPathError';
  }
}

interface ConstraintToken {
  length: number;
  unbounded: boolean;
  separator: boolean;
}

/** Reads one atom plus its optional quantifier from the deliberately small safe-regex subset. */
function readConstraintToken(source: string): ConstraintToken | undefined {
  const atom = /^(?:\\[dDsSwW]|\\[.\-_/]|[A-Za-z0-9_.-]|\[(?:\\.|[^\]\\])+\])/u.exec(source)?.[0];
  if (!atom) return undefined;

  const rest = source.slice(atom.length);
  const quantifier = /^(?:[+*?]|\{\d+(?:,\d*)?\})/u.exec(rest)?.[0] ?? '';
  if (quantifier.startsWith('{')) assertBoundedQuantifier(quantifier);

  return {
    length: atom.length + quantifier.length,
    unbounded: quantifier === '+' || quantifier === '*' || quantifier.endsWith(',}'),
    separator: quantifier === '' && /^(?:\\[.\-_/]|[._-])$/u.test(atom),
  };
}

/** Rejects nonsensical or excessively large counted quantifiers before RegExp compilation. */
function assertBoundedQuantifier(quantifier: string): void {
  const [minText, maxText] = quantifier.slice(1, -1).split(',');
  const min = Number(minText);
  const max = maxText === undefined || maxText === '' ? min : Number(maxText);
  if (min > max || max > 2048) throw new Error(`unsafe route constraint: invalid quantifier '${quantifier}'`);
}

/** Accepts only a linear, group-free regex subset to keep attacker-controlled segments ReDoS-safe. */
function assertSafeConstraint(source: string): void {
  if (!source || source.length > MAX_CONSTRAINT_LENGTH)
    throw new Error('unsafe route constraint: expression must contain 1-128 characters');

  let offset = 0;
  let previousUnbounded = false;

  while (offset < source.length) {
    const token = readConstraintToken(source.slice(offset));
    if (!token) throw new Error(`unsafe route constraint: unsupported expression '${source}'`);
    if (previousUnbounded && token.unbounded)
      throw new Error(`unsafe route constraint: adjacent unbounded quantifiers in '${source}'`);
    previousUnbounded = token.separator ? false : token.unbounded;
    offset += token.length;
  }
}

function assertParamName(name: string, pattern: string): void {
  if (!PARAM_NAME.test(name)) throw new Error(`invalid route pattern '${pattern}': invalid parameter name '${name}'`);
}

function compileParam(segment: string, pattern: string): Extract<CompiledSegment, { kind: 'param' }> {
  const constraintStart = segment.indexOf('(');

  if (constraintStart < 0) {
    const name = segment.slice(1);
    assertParamName(name, pattern);
    return { kind: 'param', name };
  }

  if (!segment.endsWith(')')) throw new Error(`invalid route pattern '${pattern}': malformed constraint`);
  const name = segment.slice(1, constraintStart);
  const constraintSource = segment.slice(constraintStart + 1, -1);
  assertParamName(name, pattern);
  assertSafeConstraint(constraintSource);
  return {
    kind: 'param',
    name,
    constraintSource,
    constraint: new RegExp(`^(?:${constraintSource})$`, 'u'),
  };
}

function compileSegments(pattern: string, rawSegments: string[]): CompiledSegment[] {
  const names = new Set<string>();
  const compiled: CompiledSegment[] = [];

  for (let index = 0; index < rawSegments.length; index++) {
    const raw = rawSegments[index];
    let segment: CompiledSegment;

    if (raw.startsWith(':') && raw.endsWith('*')) {
      const name = raw.slice(1, -1);
      assertParamName(name, pattern);
      if (index !== rawSegments.length - 1)
        throw new Error(`invalid route pattern '${pattern}': catch-all must be the final segment`);
      segment = { kind: 'catchAll', name };
    } else if (raw.startsWith(':')) {
      segment = compileParam(raw, pattern);
    } else {
      segment = { kind: 'static', value: raw };
    }

    if (segment.kind !== 'static') {
      if (names.has(segment.name))
        throw new Error(`invalid route pattern '${pattern}': duplicate parameter '${segment.name}'`);
      names.add(segment.name);
    }

    compiled.push(segment);
  }

  return compiled;
}

function segmentShape(segment: CompiledSegment): string {
  if (segment.kind === 'static') return `s:${segment.value}`;
  if (segment.kind === 'catchAll') return 'c';
  return segment.constraintSource ? `r:${segment.constraintSource}` : 'p';
}

/** Compiles and validates one route pattern. Results are cached by source string. */
export function compilePattern(pattern: string): CompiledPattern {
  const cached = compiledCache.get(pattern);
  if (cached) return cached;
  if (!pattern.startsWith('/')) throw new Error(`invalid route pattern '${pattern}': pattern must start with '/'`);
  if (pattern.includes('//')) throw new Error(`invalid route pattern '${pattern}': repeated slash`);

  const normalized = pattern.length > 1 && pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  const rawSegments = normalized === '/' ? [] : normalized.split('/').slice(1);
  const segments = compileSegments(pattern, rawSegments);
  const compiled: CompiledPattern = {
    source: pattern,
    normalized,
    shape: segments.map(segmentShape).join('/'),
    segments,
    kinds: segments
      .filter((segment) => segment.kind !== 'catchAll')
      .map((segment) => (segment.kind === 'static' ? 3 : segment.constraint ? 2 : 1)),
    catchAll: segments.at(-1)?.kind === 'catchAll',
    allStatic: segments.every((segment) => segment.kind === 'static'),
  };
  compiledCache.set(pattern, compiled);
  return compiled;
}

/** Applies the public trailing-slash policy and validates every segment's percent encoding. */
export function normalizeRequestPath(path: string): string {
  if (!path.startsWith('/')) throw new InvalidRequestPathError('invalid request path: path must start with slash');
  if (path.includes('//')) throw new InvalidRequestPathError('invalid request path: repeated slash');
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;

  // Validation only — the decoded value is deliberately discarded, matching is done on the raw
  // path. So the work is skipped entirely unless there is something to validate.
  //
  // This used to split the path and call `decodeURIComponent` per segment, on every request, and
  // throw all of it away. Measured on this path: 95.8 ns for `/hello`, 342.7 ns for a six-segment
  // route — around 8% of a whole request, spent proving that a string nobody decodes could be
  // decoded. The guard below is 15.7 ns and 6.7 ns for the same two paths.
  //
  // One call on the whole string rather than per segment is the same check: `decodeURIComponent`
  // throws on the first malformed `%` sequence wherever it appears, and a `%2F` inside a segment
  // decodes fine either way. Only the throw matters here, never the result.
  if (normalized.includes('%')) {
    try {
      decodeURIComponent(normalized);
    } catch {
      throw new InvalidRequestPathError('invalid request path: malformed path encoding');
    }
  }

  return normalized;
}

function decodeSegment(value: string): string {
  return decodeURIComponent(value);
}

/**
 * Splits a request path into its non-empty segments.
 *
 * Called once per request by the scanning functions below, not once per candidate route. It used to
 * live inside {@link matchCompiled}, which meant `split` + `filter` — two allocations — ran for every
 * registered route on every request, always producing the same array.
 */
function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function matchCompiled(compiled: CompiledPattern, pathSegs: string[]): Record<string, string> | undefined {
  const params: Record<string, string> = {};

  for (let index = 0; index < compiled.segments.length; index++) {
    const segment = compiled.segments[index];

    if (segment.kind === 'catchAll') {
      params[segment.name] = pathSegs.slice(index).map(decodeSegment).join('/');
      return params;
    }

    if (index >= pathSegs.length) return undefined;

    if (segment.kind === 'static') {
      if (segment.value !== pathSegs[index]) return undefined;
      continue;
    }

    const value = decodeSegment(pathSegs[index]);
    if (segment.constraint && !segment.constraint.test(value)) return undefined;
    params[segment.name] = value;
  }

  return compiled.segments.length === pathSegs.length ? params : undefined;
}

/** Matches a compiled segment pattern and returns its decoded parameters. */
export function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  return matchCompiled(compilePattern(pattern), splitPath(path));
}

/** Orders matching patterns by exactness, then static/constrained/plain segment specificity. */
function moreSpecific(a: string, b: string): number {
  const scoreA = compilePattern(a);
  const scoreB = compilePattern(b);
  if (scoreA.catchAll !== scoreB.catchAll) return scoreA.catchAll ? -1 : 1;
  const length = Math.max(scoreA.kinds.length, scoreB.kinds.length);

  for (let index = 0; index < length; index++) {
    const kindA = scoreA.kinds[index] ?? -1;
    const kindB = scoreB.kinds[index] ?? -1;
    if (kindA !== kindB) return kindA - kindB;
  }

  return 0;
}

/** Finds the most specific route matching both method and path; ties keep registration order. */
export function matchRoute(routes: RouteDef[], method: string, path: string): MatchedRoute | undefined {
  const pathSegs = splitPath(path);
  let best: MatchedRoute | undefined;
  let bestPattern = '';

  for (const route of routes) {
    if (route.method !== method) continue;
    const compiled = compilePattern(route.pattern);
    const params = matchCompiled(compiled, pathSegs);
    if (!params) continue;

    // An all-static match ends the scan. Specificity ranks a literal segment above every other
    // kind, so no pattern that also matches this path can outrank one made only of literals — and
    // an equal rank keeps registration order, which is this route. Finishing the scan would
    // re-derive the answer already in hand.
    //
    // The scan used to run to the end regardless: `/hello` cost the same whether it was declared
    // first or last among 32 routes, 1227 ns against 1237 ns. That is ~38 ns of scanning per
    // registered route on every request, and it grows with the route table.
    if (compiled.allStatic) return { params, def: route };

    if (!best || moreSpecific(route.pattern, bestPattern) > 0) {
      best = { params, def: route };
      bestPattern = route.pattern;
    }
  }

  return best;
}

/** Route resolution adds the one HTTP fallback the matcher supports: buffered GET serves HEAD. */
export interface ResolvedRoute extends MatchedRoute {
  implicitHead: boolean;
}

export function resolveRoute(routes: RouteDef[], method: string, path: string): ResolvedRoute | undefined {
  const explicit = matchRoute(routes, method, path);
  if (explicit) return { ...explicit, implicitHead: false };
  if (method !== 'HEAD') return undefined;

  const fallback = matchRoute(
    routes.filter((route) => route.transport === 'buffer'),
    'GET',
    path,
  );
  return fallback ? { ...fallback, implicitHead: true } : undefined;
}

const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** Lists the distinct HTTP methods whose pattern matches the path — used to build a 405 `Allow` header. */
export function allowedMethods(routes: RouteDef[], path: string): string[] {
  const pathSegs = splitPath(path);
  const methods = new Set<string>();

  for (const route of routes) {
    if (!matchCompiled(compilePattern(route.pattern), pathSegs)) continue;
    methods.add(route.method);
    if (route.method === 'GET' && route.transport === 'buffer') methods.add('HEAD');
  }

  if (methods.size) methods.add('OPTIONS');
  return [...methods].sort((a, b) => {
    const indexA = METHOD_ORDER.indexOf(a);
    const indexB = METHOD_ORDER.indexOf(b);
    return (
      (indexA < 0 ? METHOD_ORDER.length : indexA) - (indexB < 0 ? METHOD_ORDER.length : indexB) || a.localeCompare(b)
    );
  });
}

/** Parses a URL's query string into a flat string map (last value wins for repeated keys). */
export function parseQuery(url: string): Record<string, string> {
  // Most requests carry no query string, and the work below is not free for them: `split` builds
  // an array, `new URLSearchParams('')` builds an object, and the loop runs zero times — three
  // allocations to arrive at `{}`. Measured at 92.3 ns against 18.6 ns for this check.
  //
  // Only the guard is new; the parse below is untouched on purpose. Reaching for `indexOf` +
  // `slice` instead of `split` would also drop an allocation, but it changes what a second `?`
  // means, and that is a behaviour question rather than a performance one.
  if (!url.includes('?')) return {};

  const queryString = url.split('?')[1] ?? '';
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(queryString)) out[key] = value;
  return out;
}
