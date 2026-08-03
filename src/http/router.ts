import type { RouteDef, MatchedRoute } from './types';

type CompiledSegment =
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
}

const compiledCache = new Map<string, CompiledPattern>();
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CONSTRAINT_LENGTH = 128;

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
  const rawSegments = normalized.split('/').slice(1);
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
  };
  compiledCache.set(pattern, compiled);
  return compiled;
}

function decodeSegment(value: string): string {
  return decodeURIComponent(value);
}

function matchCompiled(compiled: CompiledPattern, path: string): Record<string, string> | undefined {
  const pathSegs = path.split('/').filter(Boolean);
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
  return matchCompiled(compilePattern(pattern), path);
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
