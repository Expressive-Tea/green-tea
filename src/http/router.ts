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
  };
  compiledCache.set(pattern, compiled);
  return compiled;
}

/** Matches a `.` or `..` segment, percent-encoded or not, sitting alone between separators. */
const DOT_SEGMENT = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i;

/**
 * Classifies one path segment as `.`, `..`, or neither.
 *
 * `%2e` is a dot as far as the URL spec is concerned, so `/a/%2e%2e/b` and `/a/../b` are the same
 * path. Skipping the encoded spelling would leave the encoded form as a way to reach a route the
 * plain form resolves away from.
 */
function dotSegment(segment: string): '.' | '..' | undefined {
  if (segment === '.' || segment === '..') return segment;
  if (segment.length > 6 || !segment.includes('%')) return undefined;
  const decoded = segment.toLowerCase().replace(/%2e/g, '.');
  return decoded === '.' || decoded === '..' ? decoded : undefined;
}

/**
 * Resolves `.` and `..` segments, the way RFC 3986 §5.2.4 and the WHATWG URL parser both do.
 *
 * This runs for the *Node* adapter's benefit. Every fetch-based runtime — Deno, Bun, workerd —
 * resolves dot segments inside the `Request` constructor, before green-tea is handed anything:
 * `new Request('http://x/public/../admin').url` is already `http://x/admin`. The raw target is
 * simply not recoverable there, so rejecting dot segments outright — which is what this module
 * does for `//`, and would be the stricter policy — cannot be implemented on three of the four
 * runtimes. Resolving is the only rule all four can agree on.
 *
 * Before this, the same bytes on the wire routed differently per runtime: `GET /public/../admin`
 * reached a `/admin` route under Deno/Bun/edge and 404'd under Node.
 */
function resolveDotSegments(path: string): string {
  const out: string[] = [];

  for (const segment of path.split('/').slice(1)) {
    const dots = dotSegment(segment);
    if (dots === '.') continue;

    if (dots === '..') {
      out.pop();
      continue;
    }

    out.push(segment);
  }

  return `/${out.join('/')}`;
}

/** Applies the public trailing-slash policy and validates every segment's percent encoding. */
export function normalizeRequestPath(path: string): string {
  if (!path.startsWith('/')) throw new InvalidRequestPathError('invalid request path: path must start with slash');
  if (path.includes('//')) throw new InvalidRequestPathError('invalid request path: repeated slash');

  // Two `indexOf` scans gate the regex, and the regex gates the split. A path with no `.` and no
  // `%` at all — which is most of them — pays only the scans.
  const resolved =
    (path.includes('.') || path.includes('%')) && DOT_SEGMENT.test(path) ? resolveDotSegments(path) : path;
  const normalized = resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;

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
  // Same gate `normalizeRequestPath` uses on the whole path, for the same reason: a segment with no
  // `%` decodes to itself, so the call only ever proves that. Most segments have no `%`, and this
  // runs for every param segment of every candidate route the scan reaches.
  return value.includes('%') ? decodeURIComponent(value) : value;
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

/**
 * Matches one compiled pattern against a request's segments.
 *
 * `decoded` memoizes per request, not per candidate: a scan reaching the same parameter position on
 * several routes decoded the same string once per route. Position is all decoding depends on, so one
 * array shared across the scan is the same answer for less work.
 */
function matchCompiled(
  compiled: CompiledPattern,
  pathSegs: string[],
  decoded?: Array<string | undefined>,
): Record<string, string> | undefined {
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

    const value = decoded ? (decoded[index] ??= decodeSegment(pathSegs[index])) : decodeSegment(pathSegs[index]);
    if (segment.constraint && !segment.constraint.test(value)) return undefined;
    params[segment.name] = value;
  }

  return compiled.segments.length === pathSegs.length ? params : undefined;
}

/** Matches a compiled segment pattern and returns its decoded parameters. */
export function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  return matchCompiled(compilePattern(pattern), splitPath(path));
}

/**
 * Orders patterns by exactness, then static/constrained/plain segment specificity.
 *
 * Takes compiled patterns rather than their source strings: it used to re-derive both through
 * `compilePattern`, which is a `Map` lookup each, on every comparison of every request.
 */
function moreSpecific(a: CompiledPattern, b: CompiledPattern): number {
  const scoreA = a;
  const scoreB = b;
  if (scoreA.catchAll !== scoreB.catchAll) return scoreA.catchAll ? -1 : 1;
  const length = Math.max(scoreA.kinds.length, scoreB.kinds.length);

  for (let index = 0; index < length; index++) {
    const kindA = scoreA.kinds[index] ?? -1;
    const kindB = scoreB.kinds[index] ?? -1;
    if (kindA !== kindB) return kindA - kindB;
  }

  return 0;
}

/**
 * One route at a terminal of the index.
 *
 * `rank` is the route's place in its method's specificity order — exactly the order the linear
 * matcher sorted its bucket into: `moreSpecific` first, declaration order on ties. Lower wins. The
 * tree only decides which routes *can* match; this number alone decides which one *does*, so the
 * shape of the tree can never override the global ranking (two overlapping constraints, a catch-all
 * at one depth against a param at another, an equal-rank tie).
 */
interface Terminal {
  def: RouteDef;
  compiled: CompiledPattern;
  rank: number;
  /** Position in the route array the index was built from. Breaks a tie between the two trees. */
  order: number;
  /** Every segment static: the route has no params to collect. */
  allStatic: boolean;
}

/** A `:param` edge. Plain params share one edge; constrained ones share an edge per constraint source. */
interface ParamEdge {
  constraintSource: string | undefined;
  constraint: RegExp | undefined;
  node: RadixNode;
}

// ponytail: a segment trie — one edge per whole path segment, no compression of single-child static
// chains. Lookup cost already follows path depth, not route count; compressing would save a few map
// hops on long static prefixes and costs a split/merge routine nobody has measured a need for.
interface RadixNode {
  statics: Map<string, RadixNode>;
  params: ParamEdge[];
  /** Routes whose last segment ends at this node, by rank. */
  exact: Terminal[];
  /** Catch-all routes whose fixed prefix ends at this node, by rank. They match zero or more segments. */
  catchAll: Terminal[];
  /** Lowest rank anywhere below this node: a branch that cannot beat the best match so far is skipped. */
  min: number;
}

/** One method's routes: the tree, plus its all-static routes by exact path. */
interface MethodTree {
  root: RadixNode;
  /**
   * All-static routes keyed by their normalized pattern, by rank. A hit here is the tree's best
   * match for that path: any other non-catch-all route matching it has as many segments, none of
   * them more specific than static, and every catch-all ranks below every exact route. So a static
   * request is answered without splitting the path. A miss proves nothing and falls through to the
   * walk, as does a path spelled differently from its pattern (`/a/`, `/a//b` on a direct call).
   */
  exactPaths: Map<string, Terminal[]>;
}

/**
 * The lookup index for one route array: a tree per HTTP method, local and remote kept apart.
 *
 * Mesh-spliced remote routes get their own trees so they can later be rebuilt alone when peers come
 * and go. Precedence stays the single list's: both trees answer, the more specific match wins, and
 * a tie goes to the earlier declaration — a local one, since local routes come first.
 */
interface RouteIndex {
  /** Length of the array at build time; a cached index for an array that has since grown or shrunk is rebuilt. */
  size: number;
  local: Map<string, MethodTree>;
  /** Absent for an app without mesh routes, which then does a single lookup. */
  remote: Map<string, MethodTree> | undefined;
  /** Every method with at least one route, in either tree. */
  methods: string[];
}

/** The routes a mesh teacup spliced in from its teapots. Identity-keyed, so a route is remote wherever it travels. */
const remoteRouteDefs = new WeakSet<RouteDef>();

/** Marks a route as spliced in from a mesh teapot, so the index files it in the remote tree. */
export function markRemoteRoute<T extends RouteDef>(def: T): T {
  remoteRouteDefs.add(def);
  return def;
}

/**
 * Route indexes keyed by the identity of the array they were built from.
 *
 * A server hands the same array to every request, so this is built once and collected with the
 * table it describes. Both callers (`buildAppFetch` and `listen()`) assemble that array after boot,
 * from local, remote and dev routes, and never touch it again. A table assembled fresh is a
 * different array and gets its own index.
 */
const routeIndexCache = new WeakMap<RouteDef[], RouteIndex>();

function newNode(): RadixNode {
  return { statics: new Map(), params: [], exact: [], catchAll: [], min: Infinity };
}

function childFor(node: RadixNode, segment: Exclude<CompiledSegment, { kind: 'catchAll' }>): RadixNode {
  if (segment.kind === 'static') {
    let next = node.statics.get(segment.value);
    if (!next) node.statics.set(segment.value, (next = newNode()));
    return next;
  }

  let edge = node.params.find((candidate) => candidate.constraintSource === segment.constraintSource);

  if (!edge) {
    edge = { constraintSource: segment.constraintSource, constraint: segment.constraint, node: newNode() };
    node.params.push(edge);
  }

  return edge.node;
}

/** Files one terminal. Insertion runs in rank order, so every list stays sorted and `min` is set once. */
function insert(tree: MethodTree, terminal: Terminal): void {
  let node = tree.root;
  if (node.min === Infinity) node.min = terminal.rank;

  for (const segment of terminal.compiled.segments) {
    if (segment.kind === 'catchAll') {
      node.catchAll.push(terminal);
      return;
    }

    node = childFor(node, segment);
    if (node.min === Infinity) node.min = terminal.rank;
  }

  node.exact.push(terminal);

  if (terminal.allStatic) {
    const key = terminal.compiled.normalized;
    const same = tree.exactPaths.get(key);
    if (same) same.push(terminal);
    else tree.exactPaths.set(key, [terminal]);
  }
}

/** Builds one tree per method from `(route, array position)` pairs, ranked as the linear matcher sorted them. */
function buildTrees(entries: Array<{ def: RouteDef; order: number }>): Map<string, MethodTree> {
  const byMethod = new Map<string, Terminal[]>();

  for (const { def, order } of entries) {
    const compiled = compilePattern(def.pattern);
    const allStatic = compiled.segments.every((segment) => segment.kind === 'static');
    const terminal: Terminal = { def, compiled, rank: 0, order, allStatic };
    const bucket = byMethod.get(def.method);
    if (bucket) bucket.push(terminal);
    else byMethod.set(def.method, [terminal]);
  }

  const trees = new Map<string, MethodTree>();

  for (const [method, bucket] of byMethod) {
    // `sort` is stable, so equal patterns keep registration order.
    bucket.sort((a, b) => moreSpecific(b.compiled, a.compiled));
    const tree: MethodTree = { root: newNode(), exactPaths: new Map() };
    bucket.forEach((terminal, rank) => insert(tree, Object.assign(terminal, { rank })));
    trees.set(method, tree);
  }

  return trees;
}

function routeIndex(routes: RouteDef[]): RouteIndex {
  const cached = routeIndexCache.get(routes);
  if (cached?.size === routes.length) return cached;

  const local: Array<{ def: RouteDef; order: number }> = [];
  const remote: Array<{ def: RouteDef; order: number }> = [];
  routes.forEach((def, order) => (remoteRouteDefs.has(def) ? remote : local).push({ def, order }));

  const index: RouteIndex = {
    size: routes.length,
    local: buildTrees(local),
    remote: remote.length ? buildTrees(remote) : undefined,
    methods: [...new Set(routes.map((route) => route.method))],
  };
  routeIndexCache.set(routes, index);
  return index;
}

/**
 * One request's lookup state, shared by every tree it searches: the path, its segments (split only
 * if a walk needs them), decoded values memoized by position, and the current search's filter and
 * best terminal. One object per call rather than one per tree keeps the small-table cost down.
 */
interface Search {
  path: string;
  segs: string[] | undefined;
  decoded: Array<string | undefined>;
  accept: ((def: RouteDef) => boolean) | undefined;
  best: Terminal | undefined;
}

/** Placeholder until a walk splits the path; nothing reads or writes it before then. */
const NO_DECODED: Array<string | undefined> = [];

function newSearch(path: string): Search {
  return { path, segs: undefined, decoded: NO_DECODED, accept: undefined, best: undefined };
}

function segmentsOf(search: Search): string[] {
  if (search.segs) return search.segs;
  const segs = splitPath(search.path);
  search.segs = segs;
  search.decoded = new Array(segs.length);
  return segs;
}

/** Takes the best-ranked acceptable terminal of a rank-ordered list, if it beats the best so far. */
function offer(search: Search, terminals: Terminal[]): void {
  for (let i = 0; i < terminals.length; i++) {
    const terminal = terminals[i];
    if (search.best && terminal.rank >= search.best.rank) return;
    if (search.accept && !search.accept(terminal.def)) continue;
    search.best = terminal;
    return;
  }
}

/**
 * Pending walk frames, shared by every lookup. A frame is a node and its depth; `POST` marks the
 * frame that offers a node's catch-alls once its children are done. The walk is synchronous and
 * calls no user code, and each call pops only what it pushed, so sharing is safe.
 */
const stackNodes: RadixNode[] = [];
const stackDepths: number[] = [];
const POST = -1;

/** @internal Pending frames left on the shared walk stack; zero between lookups. For tests. */
export const walkStackSize = (): number => stackNodes.length;

/**
 * Depth-first walk with backtracking: a static branch that dead-ends deeper falls back to its param,
 * constrained and catch-all siblings. Params are decoded after splitting, so `%2F` stays inside one
 * segment. Every branch that could still hold a better rank is visited; `min` prunes the rest.
 *
 * It runs on an explicit stack, not recursion, so a deep path that the linear matcher accepts cannot
 * overflow the call stack. Frames pop in the order the recursive walk visited them: static child,
 * then params in insertion order, then the node's catch-alls.
 *
 * The indexed loops and the empty-collection guards are measured, not style: at 10 routes the old
 * linear scan is a handful of string compares, and these keep the walk within D4 of it (FPRD-001).
 */
function walk(root: RadixNode, search: Search, segs: string[]): void {
  const base = stackNodes.length;
  stackNodes.push(root);
  stackDepths.push(0);

  try {
    while (stackNodes.length > base) {
      const node = stackNodes.pop()!;
      const depth = stackDepths.pop()!;

      if (depth === POST) {
        offer(search, node.catchAll);
        continue;
      }

      if (search.best && node.min >= search.best.rank) continue;

      if (node.catchAll.length) {
        stackNodes.push(node);
        stackDepths.push(POST);
      }

      if (depth === segs.length) {
        if (node.exact.length) offer(search, node.exact);
        continue;
      }

      const segment = segs[depth];
      const params = node.params;

      for (let i = params.length - 1; i >= 0; i--) {
        const edge = params[i];
        const value = (search.decoded[depth] ??= decodeSegment(segment));
        if (edge.constraint && !edge.constraint.test(value)) continue;
        stackNodes.push(edge.node);
        stackDepths.push(depth + 1);
      }

      const next = node.statics.size ? node.statics.get(segment) : undefined;

      if (next) {
        stackNodes.push(next);
        stackDepths.push(depth + 1);
      }
    }
  } finally {
    // A malformed `%` escape throws out of `decodeSegment` with frames still pending; drop them.
    stackNodes.length = base;
    stackDepths.length = base;
  }
}

function searchTree(
  tree: MethodTree | undefined,
  search: Search,
  accept: ((def: RouteDef) => boolean) | undefined,
): Terminal | undefined {
  if (!tree) return undefined;
  search.accept = accept;
  search.best = undefined;

  const exact = tree.exactPaths.get(search.path);
  if (exact) offer(search, exact);
  if (!search.best) walk(tree.root, search, segmentsOf(search));
  return search.best;
}

/** Looks a method up in both trees. The more specific match wins; an equal one goes to the earlier declaration. */
function findRoute(
  index: RouteIndex,
  method: string,
  search: Search,
  accept?: (def: RouteDef) => boolean,
): Terminal | undefined {
  const local = searchTree(index.local.get(method), search, accept);
  if (!index.remote) return local;

  const remote = searchTree(index.remote.get(method), search, accept);
  if (!local || !remote) return local ?? remote;

  const order = moreSpecific(local.compiled, remote.compiled);
  if (order !== 0) return order > 0 ? local : remote;
  return local.order < remote.order ? local : remote;
}

/** Collects the winning route's own param names and values. The walk already proved it matches. */
function paramsOf(terminal: Terminal, search: Search): Record<string, string> {
  return terminal.allStatic ? {} : matchCompiled(terminal.compiled, segmentsOf(search), search.decoded)!;
}

const isBuffered = (def: RouteDef): boolean => def.transport === 'buffer';

/**
 * Finds the most specific route matching both method and path; ties keep registration order.
 *
 * The ranking is settled when the index is built, not per request. What is left here is a walk down
 * the method's tree that visits only the branches the path can follow.
 */
export function matchRoute(routes: RouteDef[], method: string, path: string): MatchedRoute | undefined {
  const search = newSearch(path);
  const hit = findRoute(routeIndex(routes), method, search);
  return hit && { params: paramsOf(hit, search), def: hit.def };
}

/** Route resolution adds the one HTTP fallback the matcher supports: buffered GET serves HEAD. */
export interface ResolvedRoute extends MatchedRoute {
  implicitHead: boolean;
}

export function resolveRoute(routes: RouteDef[], method: string, path: string): ResolvedRoute | undefined {
  const index = routeIndex(routes);
  const search = newSearch(path);

  const explicit = findRoute(index, method, search);
  if (explicit) return { params: paramsOf(explicit, search), def: explicit.def, implicitHead: false };
  if (method !== 'HEAD') return undefined;

  // Only a buffered GET can answer HEAD. The filter applies inside the ranking, so a higher-ranked
  // streaming GET is passed over for a lower-ranked buffered one rather than ending the search.
  const fallback = findRoute(index, 'GET', search, isBuffered);
  return fallback ? { params: paramsOf(fallback, search), def: fallback.def, implicitHead: true } : undefined;
}

const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/**
 * Lists the distinct HTTP methods whose pattern matches the path — used to build a 405 `Allow` header.
 *
 * One lookup per registered method over the union of both trees. Nothing is recompiled or rescanned
 * on a miss.
 */
export function allowedMethods(routes: RouteDef[], path: string): string[] {
  const index = routeIndex(routes);
  const search = newSearch(path);
  const methods = new Set<string>();

  for (const method of index.methods) {
    // A buffered GET answers both GET and HEAD, so it is looked for first; only a GET path served
    // by streaming routes alone needs the second lookup.
    if (method === 'GET' && findRoute(index, method, search, isBuffered)) methods.add('GET').add('HEAD');
    else if (findRoute(index, method, search)) methods.add(method);
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
