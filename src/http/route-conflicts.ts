/**
 * Boot-time detection of route params that can never be reached, or that tie with a sibling
 * (FPRD-001 CARD-13, #127).
 *
 * `assertSafeConstraint` admits only a linear, group-free regex subset, so every constraint reads back
 * as a sequence of blocks — (set of characters, min, max). Intersection and the "accepts every segment"
 * question are then decided exactly, from the sets and counts, with no pattern lists and no sampling:
 *
 * - {@link intersectionWitness} walks the product of two block sequences and returns a segment both
 *   accept, or proves there is none.
 * - {@link acceptsEverySegment} is a closed-form test on the blocks; the proof is in its comment.
 *
 * The universe is what the router can actually hand a param: a *decoded*, non-empty path segment —
 * any Unicode scalar value, `/` included (from `%2F`) — except `.` and `..`, which normalization
 * resolves away before matching. Everything here is measured against that universe, so a witness is a
 * segment a real request can carry.
 *
 * Nothing here runs per request. The lookup path does not import this module.
 */
import { CONSTRAINT_ATOM, CONSTRAINT_QUANTIFIER } from './router';
import type { CompiledPattern, CompiledSegment } from './router';

// ---------------------------------------------------------------------------------------------
// Character sets: sorted, disjoint, non-adjacent inclusive ranges, flattened [lo0, hi0, lo1, hi1, …].
// ---------------------------------------------------------------------------------------------

/** A set of Unicode scalar values. */
export type CharSet = readonly number[];

const MAX_CODE_POINT = 0x10ffff;
const DOT = 0x2e;

/** Every Unicode scalar value: what a decoded segment can contain. Lone surrogates fail `decodeURIComponent`. */
const SIGMA: CharSet = [0, 0xd7ff, 0xe000, MAX_CODE_POINT];

function fromRanges(ranges: Array<[number, number]>): CharSet {
  const sorted = ranges.filter(([lo, hi]) => lo <= hi).sort((a, b) => a[0] - b[0]);
  const out: number[] = [];

  for (const [lo, hi] of sorted) {
    const last = out.length - 1;
    if (last > 0 && lo <= out[last] + 1) out[last] = Math.max(out[last], hi);
    else out.push(lo, hi);
  }

  return intersect(out, SIGMA);
}

function intersect(a: CharSet, b: CharSet): CharSet {
  const out: number[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i], b[j]);
    const hi = Math.min(a[i + 1], b[j + 1]);
    if (lo <= hi) out.push(lo, hi);
    if (a[i + 1] < b[j + 1]) i += 2;
    else j += 2;
  }

  return out;
}

/** Σ minus `set`. */
function complement(set: CharSet): CharSet {
  const out: number[] = [];
  let next = 0;

  for (let i = 0; i < set.length; i += 2) {
    if (set[i] > next) out.push(next, set[i] - 1);
    next = set[i + 1] + 1;
  }

  if (next <= MAX_CODE_POINT) out.push(next, MAX_CODE_POINT);
  return intersect(out, SIGMA);
}

function has(set: CharSet, cp: number): boolean {
  for (let i = 0; i < set.length; i += 2) if (cp >= set[i] && cp <= set[i + 1]) return true;
  return false;
}

const isEmptySet = (set: CharSet): boolean => set.length === 0;
const isSigma = (set: CharSet): boolean => set.length === SIGMA.length && set.every((v, i) => v === SIGMA[i]);

/** Readable witness characters first: digits, lowercase, uppercase, then printable ASCII. */
const PREFERRED: Array<[number, number]> = [
  [0x30, 0x39],
  [0x61, 0x7a],
  [0x41, 0x5a],
  [0x21, 0x7e],
];

/** Picks one member of a non-empty set, preferring a character a person can read in an error message. */
function pick(set: CharSet): number {
  for (const [lo, hi] of PREFERRED) {
    const within = intersect(set, [lo, hi]);
    if (within.length) return within[0];
  }

  return set[0];
}

// ---------------------------------------------------------------------------------------------
// Atoms → character sets, with the semantics of a `u`-flag RegExp (no `i`, no `s`).
// ---------------------------------------------------------------------------------------------

const DIGIT: CharSet = [0x30, 0x39];
const WORD: CharSet = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];
/** ECMAScript WhiteSpace ∪ LineTerminator, which is what `\s` matches. */
const SPACE: CharSet = fromRanges([
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]);
/** Unescaped `.` without the `s` flag: anything but a line terminator. */
const ANY_BUT_LINE_TERMINATOR: CharSet = complement(
  fromRanges([
    [0x0a, 0x0a],
    [0x0d, 0x0d],
    [0x2028, 0x2029],
  ]),
);

const CLASS_ESCAPES: Record<string, CharSet> = {
  d: DIGIT,
  D: complement(DIGIT),
  w: WORD,
  W: complement(WORD),
  s: SPACE,
  S: complement(SPACE),
};

const CONTROL_ESCAPES: Record<string, number> = { b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b };
const IDENTITY_ESCAPES = new Set('^$\\.*+?()[]{}|/-');

/** One parsed class atom: a single code point (a valid range end) or a class escape such as `\d`. */
type ClassAtom = { cp: number; end: number } | { set: CharSet; end: number };

/** Signals a construct this reader does not model; the caller then asks the RegExp engine directly. */
class Unmodelled extends Error {}

function hexAt(source: string, start: number, length: number): number {
  const text = source.slice(start, start + length);
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length !== length) throw new Unmodelled();
  return parseInt(text, 16);
}

/** Reads `\u…` (four hex digits, a surrogate pair of two, or `\u{…}`) starting after the `u`. */
function unicodeEscape(source: string, at: number): { cp: number; end: number } {
  if (source[at] === '{') {
    const close = source.indexOf('}', at);
    if (close < 0) throw new Unmodelled();
    return { cp: hexAt(source, at + 1, close - at - 1), end: close + 1 };
  }

  const cp = hexAt(source, at, 4);
  const isLead = cp >= 0xd800 && cp <= 0xdbff;

  if (isLead && source.startsWith('\\u', at + 4)) {
    const trail = hexAt(source, at + 6, 4);
    if (trail >= 0xdc00 && trail <= 0xdfff)
      return { cp: (cp - 0xd800) * 0x400 + (trail - 0xdc00) + 0x10000, end: at + 10 };
  }

  return { cp, end: at + 4 };
}

/** Reads the escape whose backslash is at `at - 1`, inside a class. */
function classEscape(source: string, at: number): ClassAtom {
  const c = source[at];
  if (CLASS_ESCAPES[c]) return { set: CLASS_ESCAPES[c], end: at + 1 };
  if (c in CONTROL_ESCAPES) return { cp: CONTROL_ESCAPES[c], end: at + 1 };
  if (IDENTITY_ESCAPES.has(c)) return { cp: c.charCodeAt(0), end: at + 1 };
  if (c === '0' && !/[0-9]/.test(source[at + 1] ?? '')) return { cp: 0, end: at + 1 };
  if (c === 'c' && /[A-Za-z]/.test(source[at + 1] ?? '')) return { cp: source.charCodeAt(at + 1) % 32, end: at + 2 };
  if (c === 'x') return { cp: hexAt(source, at + 1, 2), end: at + 3 };
  if (c === 'u') return unicodeEscape(source, at + 1);
  // `\p{…}` / `\P{…}` need Unicode property tables; anything else would not have compiled.
  throw new Unmodelled();
}

function classAtom(source: string, at: number): ClassAtom {
  if (source[at] === '\\') return classEscape(source, at + 1);
  const cp = source.codePointAt(at)!;
  return { cp, end: at + (cp > 0xffff ? 2 : 1) };
}

/** Parses the body of a `[...]` class (between the brackets) in `u` mode. */
function classSet(body: string): CharSet {
  const negated = body.startsWith('^');
  const ranges: Array<[number, number]> = [];
  const sets: CharSet[] = [];
  let at = negated ? 1 : 0;

  while (at < body.length) {
    const first = classAtom(body, at);
    at = first.end;

    // `a-z`: a dash between two single characters. A dash first, last, or next to a class escape is
    // literal — and in `u` mode a class escape next to a range dash does not compile at all.
    if (body[at] === '-' && at + 1 < body.length && 'cp' in first) {
      const last = classAtom(body, at + 1);
      if (!('cp' in last)) throw new Unmodelled();
      ranges.push([first.cp, last.cp]);
      at = last.end;
      continue;
    }

    if ('cp' in first) ranges.push([first.cp, first.cp]);
    else sets.push(first.set);
  }

  const union = fromRanges([...ranges, ...sets.flatMap((set) => pairs(set))]);
  return negated ? complement(union) : union;
}

function pairs(set: CharSet): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < set.length; i += 2) out.push([set[i], set[i + 1]]);
  return out;
}

/** The engine's own answer, one code point at a time. Only for constructs {@link classSet} does not model. */
function enumerateSet(atom: string): CharSet {
  const test = new RegExp(`^${atom}$`, 'u');
  const ranges: Array<[number, number]> = [];
  let start = -1;

  for (let cp = 0; cp <= MAX_CODE_POINT + 1; cp++) {
    const inside = cp <= MAX_CODE_POINT && (cp < 0xd800 || cp > 0xdfff) && test.test(String.fromCodePoint(cp));
    if (inside && start < 0) start = cp;

    if (!inside && start >= 0) {
      ranges.push([start, cp - 1]);
      start = -1;
    }
  }

  return fromRanges(ranges);
}

/** The set of characters one atom of the safe subset matches. */
export function atomSet(atom: string): CharSet {
  if (atom === '.') return ANY_BUT_LINE_TERMINATOR;
  if (atom.length === 1) return [atom.charCodeAt(0), atom.charCodeAt(0)];
  if (atom[0] === '\\' && CLASS_ESCAPES[atom[1]]) return CLASS_ESCAPES[atom[1]];
  if (atom[0] === '\\') return [atom.charCodeAt(1), atom.charCodeAt(1)];

  try {
    return classSet(atom.slice(1, -1));
  } catch (error) {
    if (!(error instanceof Unmodelled)) throw error;
    return enumerateSet(atom);
  }
}

// ---------------------------------------------------------------------------------------------
// Constraints → block sequences.
// ---------------------------------------------------------------------------------------------

/** `set` repeated between `min` and `max` times; `max` is `Infinity` for `+`, `*` and `{n,}`. */
export interface Block {
  set: CharSet;
  min: number;
  max: number;
}

function bounds(quantifier: string): { min: number; max: number } {
  if (quantifier === '') return { min: 1, max: 1 };
  if (quantifier === '?') return { min: 0, max: 1 };
  if (quantifier === '*') return { min: 0, max: Infinity };
  if (quantifier === '+') return { min: 1, max: Infinity };
  const [minText, maxText] = quantifier.slice(1, -1).split(',');
  const min = Number(minText);
  if (maxText === undefined) return { min, max: min };
  return { min, max: maxText === '' ? Infinity : Number(maxText) };
}

const chainCache = new Map<string, Block[]>();

/** Reads a constraint that `compilePattern` already accepted back as its sequence of blocks. */
export function constraintBlocks(source: string): Block[] {
  const cached = chainCache.get(source);
  if (cached) return cached;

  const blocks: Block[] = [];
  let offset = 0;

  while (offset < source.length) {
    const rest = source.slice(offset);
    const atom = CONSTRAINT_ATOM.exec(rest)![0];
    const quantifier = CONSTRAINT_QUANTIFIER.exec(rest.slice(atom.length))?.[0] ?? '';
    blocks.push({ set: atomSet(atom), ...bounds(quantifier) });
    offset += atom.length + quantifier.length;
  }

  chainCache.set(source, blocks);
  return blocks;
}

/** What a plain `:param` accepts: any non-empty segment. */
const ANY_SEGMENT: Block[] = [{ set: SIGMA, min: 1, max: Infinity }];

// ---------------------------------------------------------------------------------------------
// Universality.
// ---------------------------------------------------------------------------------------------

/**
 * Whether a block sequence accepts every segment a request can carry.
 *
 * True exactly when (1) some block is Σ with no upper bound, (2) every block with `min ≥ 1` is Σ, and
 * (3) the mins add up to at most 1. Sufficient: skip every optional block, and the unbounded Σ block
 * takes whatever the mandatory ones leave over. Necessary, each against a segment in the universe:
 * (3) fails on `a`, too short; (2) fails on `zzz…`, with `z` outside the mandatory block's set; and
 * without (1), take `zⱼ` outside each unbounded block's set and repeat the round `z₁…zₜ` more times
 * than the bounded blocks' total capacity plus `t`. Blocks are consumed in order, so some round
 * lands wholly inside one unbounded block, which cannot hold its own `zⱼ`.
 *
 * Excluding `.` and `..` from the universe changes nothing: every counterexample above is longer or
 * is `a`.
 */
export function acceptsEverySegment(blocks: Block[]): boolean {
  const unboundedSigma = blocks.some((block) => block.max === Infinity && isSigma(block.set));
  const mandatoryAreSigma = blocks.every((block) => block.min === 0 || isSigma(block.set));
  const minLength = blocks.reduce((sum, block) => sum + block.min, 0);
  return unboundedSigma && mandatoryAreSigma && minLength <= 1;
}

// ---------------------------------------------------------------------------------------------
// Intersection with a witness.
// ---------------------------------------------------------------------------------------------

/** Entry `i`: every block after block `i` is optional, so the sequence may stop once block `i` is done. */
function endsAfter(blocks: Block[]): boolean[] {
  const out = new Array<boolean>(blocks.length);
  let optionalTail = true;

  for (let i = blocks.length - 1; i >= 0; i--) {
    out[i] = optionalTail;
    optionalTail &&= blocks[i].min === 0;
  }

  return out;
}

/**
 * The reachable configurations on entry to one pair of blocks (`a` in sequence A, `b` in sequence B).
 *
 * `fresh` names the side that has just entered its block and has consumed nothing in it yet; the
 * other side, the carry, has already consumed `value` characters of its block. Both fresh is `fresh
 * = 'a'` with `value = 0`. Unbounded blocks clamp the counter at their `min`, since every count past
 * it behaves the same, so `value` never exceeds the carry block's `max`, or its `min` when unbounded.
 *
 * `dotsOnly` stays true while every character so far is `.`: a witness must not be `.` or `..`.
 */
interface EntryState {
  a: number;
  b: number;
  fresh: 'a' | 'b';
  dotsOnly: boolean;
  reached: Uint8Array;
  /** Union-find "next unreached value", so each value is filled once however many predecessors reach it. */
  free: Int32Array;
  prev: Array<EntryState | undefined>;
  prevValue: Int32Array;
  runChar: Int32Array;
  runLength: Int32Array;
}

/** How a state was reached: from `(from, value)` by a run of `char`, at least `tLo` long. */
interface Run {
  from: EntryState | undefined;
  value: number;
  char: number;
  tLo: number;
}

/** Who is fresh in the next state: both sides, the same side as now, or the side that was the carry. */
type NextFresh = 'both' | 'same' | 'flip';

const counterCap = (block: Block): number => (block.max === Infinity ? block.min : block.max);
const clampTo = (block: Block, count: number): number => (block.max === Infinity ? Math.min(count, block.min) : count);

function findFree(state: EntryState, x: number): number {
  while (state.free[x] !== x) x = state.free[x] = state.free[state.free[x]];
  return x;
}

class ProductWalk {
  private readonly states = new Map<string, EntryState>();
  private readonly endA: boolean[];
  private readonly endB: boolean[];

  constructor(
    private readonly A: Block[],
    private readonly B: Block[],
  ) {
    this.endA = endsAfter(A);
    this.endB = endsAfter(B);
  }

  /** Returns a non-empty string in both languages that is neither `.` nor `..`, or `undefined` if none exists. */
  witness(): string | undefined {
    this.fill(this.state(0, 0, 'a', true), 0, 0, { from: undefined, value: 0, char: 0, tLo: 0 }, 0);

    // Every transition moves to a later `a`, or to the same `a` and a later `b`, so visiting pairs in
    // that order sees each state after everything that reaches it.
    for (let a = 0; a < this.A.length; a++)
      for (let b = 0; b < this.B.length; b++)
        for (const key of [`${a},${b},a,1`, `${a},${b},a,0`, `${a},${b},b,1`, `${a},${b},b,0`]) {
          const state = this.states.get(key);
          const found = state && this.expand(state);
          if (found !== undefined) return found;
        }

    return undefined;
  }

  private state(a: number, b: number, fresh: 'a' | 'b', dotsOnly: boolean): EntryState {
    const key = `${a},${b},${fresh},${dotsOnly ? 1 : 0}`;
    let state = this.states.get(key);

    if (!state) {
      const size = counterCap(fresh === 'a' ? this.B[b] : this.A[a]) + 1;
      state = {
        a,
        b,
        fresh,
        dotsOnly,
        reached: new Uint8Array(size),
        free: new Int32Array(size + 1).map((_, i) => i),
        prev: new Array(size),
        prevValue: new Int32Array(size),
        runChar: new Int32Array(size),
        runLength: new Int32Array(size),
      };
      this.states.set(key, state);
    }

    return state;
  }

  /** Marks `[lo, hi]` reached in `target`; value `w` came by a run of length `max(tLo, w - offset)`. */
  private fill(target: EntryState, lo: number, hi: number, run: Run, offset: number): void {
    for (let w = findFree(target, lo); w <= hi; w = findFree(target, w + 1)) {
      target.reached[w] = 1;
      target.prev[w] = run.from;
      target.prevValue[w] = run.value;
      target.runChar[w] = run.char;
      target.runLength[w] = Math.max(run.tLo, w - offset);
      target.free[w] = w + 1;
    }
  }

  /**
   * The state after one or both sides move to their next block, from the current fresh side's point
   * of view: `freshAt` is the fresh side's block index, `carryAt` the carry side's. `undefined` when
   * a side would run past its last block.
   */
  private next(state: EntryState, freshAt: number, carryAt: number, mode: NextFresh, dotsOnly: boolean) {
    const freshIsA = state.fresh === 'a';
    const [a, b] = freshIsA ? [freshAt, carryAt] : [carryAt, freshAt];
    if (a >= this.A.length || b >= this.B.length) return undefined;
    const nextFreshIsA = mode === 'both' || (mode === 'same' ? freshIsA : !freshIsA);
    return this.state(a, b, nextFreshIsA ? 'a' : 'b', dotsOnly);
  }

  /** Follows every move out of one entry state. Returns a witness as soon as one completes. */
  private expand(state: EntryState): string | undefined {
    this.skip(state);
    const shared = intersect(this.A[state.a].set, this.B[state.b].set);
    if (isEmptySet(shared)) return undefined;

    const notDot = intersect(shared, complement([DOT, DOT]));
    const char = isEmptySet(notDot) ? DOT : pick(notDot);
    const dotsOnly = state.dotsOnly && char === DOT;

    for (let value = 0; value < state.reached.length; value++) {
      if (!state.reached[value]) continue;
      const found = this.runFrom(state, value, char, dotsOnly);
      if (found !== undefined) return found;
    }

    return undefined;
  }

  /**
   * Zero-length moves past optional blocks. The fresh side may skip a `min = 0` block it has not
   * started, keeping the carry's count; a carry still at 0 in a `min = 0` block may skip it too.
   * Skipping one block at a time keeps every value's moves O(1); runs of optional blocks chain.
   */
  private skip(state: EntryState): void {
    const freshIsA = state.fresh === 'a';
    const [freshAt, carryAt] = freshIsA ? [state.a, state.b] : [state.b, state.a];
    const fresh = freshIsA ? this.A[state.a] : this.B[state.b];
    const carry = freshIsA ? this.B[state.b] : this.A[state.a];
    const keep = (value: number): Run => ({ from: state, value, char: 0, tLo: 0 });
    const freshSkip = fresh.min === 0 ? this.next(state, freshAt + 1, carryAt, 'same', state.dotsOnly) : undefined;

    for (let value = 0; freshSkip && value < state.reached.length; value++)
      if (state.reached[value]) this.fill(freshSkip, value, value, keep(value), value);

    const carrySkip =
      carry.min === 0 && state.reached[0] && this.next(state, freshAt, carryAt + 1, 'same', state.dotsOnly);
    if (carrySkip) this.fill(carrySkip, 0, 0, keep(0), 0);
  }

  /** A run of `t ≥ 1` copies of `char` in the current pair, then one or both sides leave their block. */
  private runFrom(state: EntryState, value: number, char: number, dotsOnly: boolean): string | undefined {
    const freshIsA = state.fresh === 'a';
    const [freshAt, carryAt] = freshIsA ? [state.a, state.b] : [state.b, state.a];
    const fresh = freshIsA ? this.A[state.a] : this.B[state.b];
    const carry = freshIsA ? this.B[state.b] : this.A[state.a];
    const tHi = Math.min(fresh.max, carry.max - value);
    if (tHi < 1) return undefined;

    // Both leave: the run completes both blocks at once — and may complete the whole string.
    const bothLo = Math.max(1, fresh.min, carry.min - value);

    if (bothLo <= tHi) {
      if (!dotsOnly && this.endA[state.a] && this.endB[state.b]) return this.trace(state, value, char, bothLo);
      const target = this.next(state, freshAt + 1, carryAt + 1, 'both', dotsOnly);
      if (target) this.fill(target, 0, 0, { from: state, value, char, tLo: bothLo }, 0);
    }

    // The fresh side leaves; the carry stays in its block, `t` characters further on.
    const freshLo = Math.max(1, fresh.min);
    const same = freshLo <= tHi && this.next(state, freshAt + 1, carryAt, 'same', dotsOnly);
    if (same)
      this.fill(
        same,
        clampTo(carry, value + freshLo),
        clampTo(carry, value + tHi),
        { from: state, value, char, tLo: freshLo },
        value,
      );

    // The carry leaves; the fresh side stays, `t` characters in, and becomes the carry.
    const carryLo = Math.max(1, carry.min - value);
    const flip = carryLo <= tHi && this.next(state, freshAt, carryAt + 1, 'flip', dotsOnly);
    if (flip)
      this.fill(flip, clampTo(fresh, carryLo), clampTo(fresh, tHi), { from: state, value, char, tLo: carryLo }, 0);
    return undefined;
  }

  /** Rebuilds the witness by following predecessors back to the start. */
  private trace(state: EntryState, value: number, char: number, length: number): string {
    const runs: string[] = [String.fromCodePoint(char).repeat(length)];
    let at: EntryState | undefined = state;
    let v = value;

    while (at) {
      if (at.runLength[v]) runs.push(String.fromCodePoint(at.runChar[v]).repeat(at.runLength[v]));
      const prev: EntryState | undefined = at.prev[v];
      v = at.prevValue[v];
      at = prev;
    }

    return runs.reverse().join('');
  }
}

/** The lengths of the all-dot strings a sequence accepts: an interval, since a sum of intervals is one. */
function dotLengths(blocks: Block[]): [number, number] | undefined {
  let lo = 0;
  let hi = 0;

  for (const block of blocks) {
    const dot = has(block.set, DOT);
    if (!dot && block.min > 0) return undefined;
    lo += block.min;
    if (dot) hi += block.max;
  }

  return [lo, hi];
}

/**
 * A segment both block sequences accept, or `undefined` when their languages share none.
 *
 * Exact over the decoded-segment universe. The product walk finds any common string containing a
 * character other than `.`; the all-dot strings are an interval of lengths per side, and a common one
 * of length 3 or more is `...`, a segment normalization keeps.
 *
 * Cost: at most 4·|A|·|B| entry states, each holding at most K + 1 counter values (K ≤ 2048, the
 * largest quantifier bound the subset allows), each value expanded into at most |A| + |B| successor
 * fills that union-find keeps linear. O(|A|·|B|·(|A| + |B|)·K), with |A|, |B| ≤ 128 blocks.
 */
export function intersectionWitness(A: Block[], B: Block[]): string | undefined {
  const found = new ProductWalk(A, B).witness();
  if (found !== undefined) return found;

  const dotsA = dotLengths(A);
  const dotsB = dotLengths(B);
  if (!dotsA || !dotsB) return undefined;
  const length = Math.max(3, dotsA[0], dotsB[0]);
  return length <= Math.min(dotsA[1], dotsB[1]) ? '.'.repeat(length) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Route patterns.
// ---------------------------------------------------------------------------------------------

/**
 * How a table picks between two routes that match the same request.
 *
 * `specificity` is the HTTP router: static > constrained > plain at the first differing segment,
 * registration order on a tie. `registration` is the WebSocket matcher, which takes the first route
 * declared that matches (frozen as observed by the parity corpus, `matcher-ws.json`).
 */
export type Precedence = 'specificity' | 'registration';

export type RouteConflict =
  /** Two constrained siblings accept a common segment: `segment` decoded, `path` a request both match. */
  | { kind: 'ambiguous'; segment: string; path: string }
  /** The route at `loser` (0 = first argument, 1 = second) can never be selected: the other wins every request it matches. */
  | { kind: 'unreachable'; loser: 0 | 1 };

type Param = Extract<CompiledSegment, { kind: 'param' }>;

const blocksOf = (segment: Param): Block[] =>
  segment.constraintSource ? constraintBlocks(segment.constraintSource) : ANY_SEGMENT;

function decodedStatic(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    // A request segment spelling `.` or `..` is resolved away before matching, so no request reaches it.
    return decoded === '.' || decoded === '..' ? undefined : decoded;
  } catch {
    return undefined;
  }
}

/** A raw request segment that `segment` alone accepts, or `undefined` if it accepts none. */
function segmentWitness(segment: CompiledSegment): string | undefined {
  if (segment.kind === 'static') return decodedStatic(segment.value) === undefined ? undefined : segment.value;
  if (segment.kind === 'catchAll') return undefined;
  const value = intersectionWitness(blocksOf(segment), ANY_SEGMENT);
  return value === undefined ? undefined : encodeURIComponent(value);
}

/** A raw request segment both accept, or `undefined`. */
function overlapWitness(x: CompiledSegment, y: CompiledSegment): string | undefined {
  if (x.kind === 'static' && y.kind === 'static') return x.value === y.value ? segmentWitness(x) : undefined;

  if (x.kind === 'static' || y.kind === 'static') {
    const [fixed, param] = (x.kind === 'static' ? [x, y] : [y, x]) as [
      Extract<CompiledSegment, { kind: 'static' }>,
      Param,
    ];
    const decoded = decodedStatic(fixed.value);
    return decoded !== undefined && (!param.constraint || param.constraint.test(decoded)) ? fixed.value : undefined;
  }

  const value = intersectionWitness(blocksOf(x as Param), blocksOf(y as Param));
  return value === undefined ? undefined : encodeURIComponent(value);
}

/** Witness segments for every fixed segment from `from` on, or `undefined` if one accepts nothing. */
function restWitness(segments: CompiledSegment[], from: number): string[] | undefined {
  const out: string[] = [];

  for (const segment of segments.slice(from)) {
    if (segment.kind === 'catchAll') break;
    const witness = segmentWitness(segment);
    if (witness === undefined) return undefined;
    out.push(witness);
  }

  return out;
}

/** Raw segments of a request both patterns match from position `from` on, or `undefined` if none exists. */
function overlapFrom(a: CompiledPattern, b: CompiledPattern, from: number): string[] | undefined {
  const out: string[] = [];

  for (let m = from; ; m++) {
    const x = a.segments[m];
    const y = b.segments[m];
    // A catch-all takes zero or more segments, so it absorbs whatever the other side still needs.
    if (x?.kind === 'catchAll') return concat(out, restWitness(b.segments, m));
    if (y?.kind === 'catchAll') return concat(out, restWitness(a.segments, m));
    if (!x || !y) return x || y ? undefined : out;
    const witness = overlapWitness(x, y);
    if (witness === undefined) return undefined;
    out.push(witness);
  }
}

const concat = (head: string[], tail: string[] | undefined): string[] | undefined => tail && [...head, ...tail];

/** Whether every segment `lower` accepts, `higher` accepts too. Two different constraints are not compared. */
function segmentIncluded(lower: CompiledSegment, higher: CompiledSegment): boolean {
  if (higher.kind === 'static') return lower.kind === 'static' && lower.value === higher.value;
  if (higher.kind === 'catchAll' || lower.kind === 'catchAll') return false;
  if (!higher.constraintSource) return true;

  if (lower.kind === 'static') {
    const decoded = decodedStatic(lower.value);
    return decoded === undefined || higher.constraint!.test(decoded);
  }

  return lower.constraintSource === higher.constraintSource || acceptsEverySegment(blocksOf(higher));
}

/** Whether `higher` matches every request `lower` matches, from position `from` on. */
function includedFrom(lower: CompiledPattern, higher: CompiledPattern, from: number): boolean {
  for (let m = from; ; m++) {
    const l = lower.segments[m];
    const h = higher.segments[m];
    if (h?.kind === 'catchAll') return true;
    if (!l || !h) return !l && !h;
    if (!segmentIncluded(l, h)) return false;
  }
}

/** The position of the first segment whose shape differs — the radix node where the two routes branch. */
function branchPoint(a: CompiledPattern, b: CompiledPattern): number {
  const length = Math.max(a.segments.length, b.segments.length);

  for (let k = 0; k < length; k++) {
    const x = a.segments[k];
    const y = b.segments[k];
    if (!x || !y || shapeOf(x) !== shapeOf(y)) return k;
  }

  return -1;
}

/**
 * Whether `first` beats `second` on a request both match, given that they branch at a constrained
 * param against a plain one. `firstConstrained` says which side holds the constraint.
 *
 * Under `specificity` this is the router's own ranking: an exact route beats a catch-all route
 * outright, and otherwise the constrained param beats the plain one at the branch, since every
 * segment before it has the same kind. Under `registration` the earlier declaration wins.
 */
function winsBranch(
  first: CompiledPattern,
  second: CompiledPattern,
  firstConstrained: boolean,
  precedence: Precedence,
) {
  if (precedence === 'registration') return true;
  if (first.catchAll !== second.catchAll) return !first.catchAll;
  return firstConstrained;
}

function shapeOf(segment: CompiledSegment): string {
  if (segment.kind === 'static') return `s:${segment.value}`;
  if (segment.kind === 'catchAll') return 'c';
  return segment.constraintSource ? `r:${segment.constraintSource}` : 'p';
}

/**
 * Whether two routes of the same method, in the same table, conflict. `first` was declared before
 * `second`.
 *
 * **Siblings.** Two routes are siblings at position `k` when their segments before `k` have the same
 * shape — they share a node of the radix tree — and both segments at `k` are params, at least one of
 * them constrained. Statics and catch-alls are not sibling params: a static wins on the raw segment
 * (a constrained twin is still reachable through a percent-encoded spelling), and a catch-all ranks
 * below every exact route. Equal shapes everywhere is the duplicate-shape error, checked elsewhere.
 *
 * **Ambiguous** (both constrained): the two constraints accept a common segment, *and* the full
 * patterns can match one request — every later position pair overlaps, a catch-all absorbing the
 * rest. `/u/:id(\d+)/a` and `/u/:n(\d{1,3})/b` share digits at the branch but no request, so they do
 * not conflict. The witness is the common segment at the branch, plus a whole request path.
 *
 * **Unreachable** (one constrained, one plain): the route that loses the branch can never be chosen
 * when the winner also matches everything it matches. The winner is the constrained one under
 * `specificity`, which then needs a constraint that accepts every segment; under `registration` it is
 * whichever was declared first. (An exact route beats a catch-all one under `specificity` whatever
 * the branch holds, and no exact route can include a catch-all.) Later positions must be included
 * segment by segment. Inclusion
 * between two *different* constraints at a later position is not attempted — it is not known to be
 * polynomial for this grammar — and counts as not included, so such a route boots.
 */
export function routeConflict(
  first: CompiledPattern,
  second: CompiledPattern,
  precedence: Precedence,
): RouteConflict | undefined {
  const k = branchPoint(first, second);
  const x = first.segments[k];
  const y = second.segments[k];
  if (k < 0 || x?.kind !== 'param' || y?.kind !== 'param') return undefined;
  if (!x.constraintSource && !y.constraintSource) return undefined;

  const prefix = restWitness(first.segments.slice(0, k), 0);
  if (!prefix) return undefined;

  if (x.constraintSource && y.constraintSource) {
    const segment = intersectionWitness(blocksOf(x), blocksOf(y));
    const rest = segment === undefined ? undefined : overlapFrom(first, second, k + 1);
    if (segment === undefined || !rest) return undefined;
    return { kind: 'ambiguous', segment, path: `/${[...prefix, encodeURIComponent(segment), ...rest].join('/')}` };
  }

  const firstWins = winsBranch(first, second, Boolean(x.constraintSource), precedence);
  const [winner, loser] = firstWins ? [first, second] : [second, first];
  const winnerParam = firstWins ? x : y;
  if (winnerParam.constraintSource && !acceptsEverySegment(blocksOf(winnerParam))) return undefined;
  return includedFrom(loser, winner, k + 1) ? { kind: 'unreachable', loser: firstWins ? 1 : 0 } : undefined;
}
