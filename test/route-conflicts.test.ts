/**
 * The decision procedure behind CARD-13 (#127): constraint atoms read back as character sets,
 * intersection with a witness, "accepts every segment", and the route-level definitions.
 *
 * Every answer is checked against the RegExp engine itself, which is the router's ground truth: atom
 * sets code point by code point, witnesses by matching them, and the product walk against brute-force
 * enumeration over short strings (fixed seed).
 */
import { describe, it, expect } from 'vitest';
import { compilePattern } from '../src/http/router';
import {
  acceptsEverySegment,
  atomSet,
  constraintBlocks,
  intersectionWitness,
  routeConflict,
  type CharSet,
  type Precedence,
} from '../src/http/route-conflicts';

const engine = (source: string) => new RegExp(`^(?:${source})$`, 'u');
/** What the router can hand a param: non-empty, and never `.` or `..` (normalization resolves them). */
const inUniverse = (segment: string) => segment.length > 0 && segment !== '.' && segment !== '..';

function inSet(set: CharSet, cp: number): boolean {
  for (let i = 0; i < set.length; i += 2) if (cp >= set[i] && cp <= set[i + 1]) return true;
  return false;
}

/** All of the BMP but surrogates, a stride through the astral planes, and every range edge ± 1. */
function probes(set: CharSet): number[] {
  const out: number[] = [];
  for (let cp = 0; cp <= 0xffff; cp++) if (cp < 0xd800 || cp > 0xdfff) out.push(cp);
  for (let cp = 0x10000; cp <= 0x10ffff; cp += 97) out.push(cp);
  for (const edge of set) out.push(edge - 1, edge, edge + 1);
  return out.filter((cp) => cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff));
}

const ATOMS = [
  '\\d',
  '\\D',
  '\\w',
  '\\W',
  '\\s',
  '\\S',
  '.',
  '\\.',
  'a',
  '_',
  '-',
  '[a-z]',
  '[^a-z]',
  '[^]',
  '[\\s\\S]',
  '[\\d\\-x]',
  '[-a]',
  '[a-]',
  '[^.]',
  '[\\u0041-\\u005A]',
  '[\\u{1F600}-\\u{1F602}]',
  '[\\uD83D\\uDE00]',
  '[\\x00-\\x1f]',
  '[\\b\\cJ\\0\\t]',
  '[\\]\\[\\\\\\/]',
  '[😀-😂]',
  '[\\p{L}]',
  '[^\\P{Nd}]',
];

describe('constraint atoms read back as character sets', () => {
  it.each(ATOMS)('%s matches exactly what the engine matches', (atom) => {
    const set = atomSet(atom);
    const test = engine(atom);
    const wrong = probes(set).filter((cp) => inSet(set, cp) !== test.test(String.fromCodePoint(cp)));
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it('an unescaped dot is not every character: line terminators are outside it', () => {
    // Without the `s` flag, `.` excludes \n, \r, U+2028 and U+2029 — so `(.*)` does not cover every
    // segment, and `/algo/%0A` still reaches a plain sibling. This is the router's real behaviour.
    const dot = atomSet('.');
    expect([0x0a, 0x0d, 0x2028, 0x2029].map((cp) => inSet(dot, cp))).toEqual([false, false, false, false]);
    expect(acceptsEverySegment(constraintBlocks('.*'))).toBe(false);
    expect(acceptsEverySegment(constraintBlocks('[^]*'))).toBe(true);
  });
});

describe('acceptsEverySegment', () => {
  it.each([
    ['[^]*', true],
    ['[^]+', true],
    ['[\\s\\S]*', true],
    ['[\\s\\S]{0,4}[^]*', true],
    ['[^]?[^]*', true],
    ['a?[^]*', true],
    ['[^][^]+', false], // needs two characters: `a` is a segment
    ['a[^]*', false], // a mandatory block narrower than Σ
    ['[^]{0,2048}', false], // bounded
    ['.*', false],
    ['\\S+', false],
    ['[a-z]*[^]{1,2048}', false],
  ])('%s → %s', (source, expected) => {
    expect(acceptsEverySegment(constraintBlocks(source))).toBe(expected);
  });
});

// ── property: the product walk against brute force ───────────────────────────────────────────────

/** mulberry32, fixed seed: the generated pairs are the same on every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 13127;
const GEN_ATOMS = [
  '\\d',
  '\\D',
  '\\w',
  '\\s',
  '\\S',
  '.',
  '\\.',
  'a',
  '0',
  '-',
  '[a-c]',
  '[^0-9]',
  '[.a]',
  '[^.]',
  '[^]',
];
const GEN_QUANTIFIERS = ['', '', '?', '*', '+', '{0,2}', '{1,3}', '{2}', '{1,}'];
const PROBE_CHARS = ['0', '5', 'a', 'c', 'Z', '.', '-', '_', ' ', '\n', 'é', '😀', '/'];

function randomConstraint(next: () => number): string | undefined {
  const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)];
  const atoms = 1 + Math.floor(next() * 3);
  let source = '';
  for (let i = 0; i < atoms; i++) source += pick(GEN_ATOMS) + pick(GEN_QUANTIFIERS);

  try {
    compilePattern(`/p/:x(${source})`); // only what the router accepts
    return source;
  } catch {
    return undefined;
  }
}

function shortStrings(maxLength: number): string[] {
  let level = [''];
  const out: string[] = [];

  for (let length = 1; length <= maxLength; length++) {
    level = level.flatMap((prefix) => PROBE_CHARS.map((c) => prefix + c));
    out.push(...level);
  }

  return out.filter(inUniverse);
}

describe('intersectionWitness', () => {
  const STRINGS = shortStrings(3);

  it(`agrees with brute force over short strings (seed ${SEED})`, () => {
    const next = rng(SEED);
    let pairs = 0;
    let intersecting = 0;

    while (pairs < 300) {
      const a = randomConstraint(next);
      const b = randomConstraint(next);
      if (!a || !b) continue;
      pairs++;

      const witness = intersectionWitness(constraintBlocks(a), constraintBlocks(b));
      const [ra, rb] = [engine(a), engine(b)];
      const brute = STRINGS.find((s) => ra.test(s) && rb.test(s));

      // Sound: a witness is a real segment both accept.
      if (witness !== undefined) {
        intersecting++;
        expect({ a, b, witness, ok: inUniverse(witness) && ra.test(witness) && rb.test(witness) }).toMatchObject({
          ok: true,
        });
      }

      // Complete: anything brute force finds, the walk finds too.
      if (brute !== undefined) expect({ a, b, brute, found: witness !== undefined }).toMatchObject({ found: true });
    }

    // Both outcomes are exercised, not just one.
    expect(intersecting).toBeGreaterThan(30);
    expect(pairs - intersecting).toBeGreaterThan(30);
  });

  it.each([
    ['\\d+', '\\d{1,3}', '0'],
    ['\\d+', '[0-9]+', '0'],
    ['\\d+', '[a-z]+', undefined],
    ['\\d{2}', '\\d{3}', undefined],
    ['a\\d{2}', '\\w{3}', 'a00'],
    ['\\.', '[.]', undefined], // only `.`, which normalization removes
    ['\\.{1,2}', '[.]+', undefined], // `.` and `..` only
    ['\\.+', '[.]{2,5}', '...'],
    ['[^]{3}', '\\D\\d', undefined],
    ['[^]{3}', '\\D\\d-', 'a0-'],
    ['\\d{0,2048}', '[0-9]{0,2048}', '0'],
    ['\\d{0,2048}', '[a-z]{0,2048}', undefined],
    ['\\d{2048}', '\\d{0,2047}', undefined],
  ])('%s ∩ %s → %s', (a, b, expected) => {
    const witness = intersectionWitness(constraintBlocks(a), constraintBlocks(b));
    expect(witness).toBe(expected);
    if (witness !== undefined) expect(engine(a).test(witness) && engine(b).test(witness)).toBe(true);
  });

  it('T9: {0,2048} against {0,2048}, and the largest product the grammar allows, stay well inside boot time', () => {
    // A {0,2048} block is 10 source characters, so 12 fill the 128-character limit. The trailing
    // `a` / `b` makes the intersection empty, so the walk must visit every reachable state.
    const worstA = constraintBlocks('\\d{0,2048}'.repeat(12) + 'a');
    const worstB = constraintBlocks('[0-9]{0,2048}'.repeat(9) + 'b');
    const started = performance.now();
    expect(intersectionWitness(constraintBlocks('\\d{0,2048}'), constraintBlocks('[0-9]{0,2048}'))).toBe('0');
    expect(intersectionWitness(worstA, worstB)).toBeUndefined();
    // Measured at ~0.1 ms and ~100 ms on an M-series laptop; the bound only guards against a
    // regression to the exponential or quadratic-per-value walk.
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

// ── route level ──────────────────────────────────────────────────────────────────────────────────

const conflict = (a: string, b: string, precedence: Precedence = 'specificity') =>
  routeConflict(compilePattern(a), compilePattern(b), precedence);

describe('routeConflict', () => {
  it.each([
    // Rule 1: a constraint that accepts every segment outranks a plain sibling, whatever the order.
    ['/algo/:id', '/algo/:a([^]*)', { kind: 'unreachable', loser: 0 }],
    ['/algo/:a([\\s\\S]+)', '/algo/:id', { kind: 'unreachable', loser: 1 }],
    ['/algo/:id', '/algo/:a(.*)', undefined], // `.` leaves line terminators to `:id`
    // Rule 2, with the whole-pattern condition.
    ['/u/:id(\\d+)', '/u/:n(\\d{1,3})', { kind: 'ambiguous', segment: '0', path: '/u/0' }],
    ['/u/:id(\\d+)', '/u/:id([0-9]+)', { kind: 'ambiguous', segment: '0', path: '/u/0' }],
    ['/u/:id(\\d+)/a', '/u/:n(\\d{1,3})/b', undefined],
    ['/u/:id(\\d+)/a', '/u/:n(\\d{1,3})/:x', { kind: 'ambiguous', segment: '0', path: '/u/0/a' }],
    ['/u/:id(\\d+)/:r*', '/u/:n(\\d{1,3})/x/y', { kind: 'ambiguous', segment: '0', path: '/u/0/x/y' }],
    ['/u/:id(\\d+)', '/u/:n(\\d{1,3})/:r*', { kind: 'ambiguous', segment: '0', path: '/u/0' }],
    ['/:p([a-z]+)/:id(\\d+)', '/:p([a-z]+)/:n(\\d{2})', { kind: 'ambiguous', segment: '00', path: '/a/00' }],
    // Rule 3 and other non-errors.
    ['/u/:id(\\d+)', '/u/:slug', undefined],
    ['/u/:id(\\d+)', '/u/:s([a-z]+)', undefined],
    ['/u/me', '/u/:id(me)', undefined], // a static is not a sibling param: `/u/%6De` still reaches `:id`
    ['/x/:a/:id(\\d+)', '/x/s/:n([0-9]+)', undefined], // different radix nodes: the static decides
    ['/a/:id', '/a/:x([^]*)/:r*', undefined], // an exact route outranks a catch-all one
    // Rule 1 needs the rest included, segment by segment.
    ['/a/:x([^]+)/b', '/a/:id/c', undefined],
    ['/a/:x([^]+)/:y', '/a/:id/c', { kind: 'unreachable', loser: 1 }],
    ['/a/:x([^]+)/:y/:r*', '/a/:id/c/:s*', { kind: 'unreachable', loser: 1 }],
    ['/a/:x([^]+)/:r*', '/a/:id/c/d', undefined], // the exact route outranks the catch-all one
    ['/a/:x([^]+)/:y(\\d+)', '/a/:id/:z(\\d+)', { kind: 'unreachable', loser: 1 }],
    // Different constraints at a later position are not compared, so this boots (documented limit).
    ['/a/:x([^]+)/:y(\\d+)', '/a/:id/:z([0-9]+)', undefined],
  ])('%s vs %s', (a, b, expected) => {
    expect(conflict(a, b)).toEqual(expected);
  });

  it('WebSocket precedence is declaration order', () => {
    expect(conflict('/r/:id', '/r/:a(.*)', 'registration')).toEqual({ kind: 'unreachable', loser: 1 });
    expect(conflict('/r/:slug', '/r/:id(\\d+)', 'registration')).toEqual({ kind: 'unreachable', loser: 1 });
    expect(conflict('/r/:id(\\d+)', '/r/:slug', 'registration')).toBeUndefined();
    expect(conflict('/r/:id(\\d+)', '/r/:n(\\d{1,3})', 'registration')).toMatchObject({ kind: 'ambiguous' });
  });

  it('every ambiguous witness path is a request both routes really match', async () => {
    const { matchPattern } = await import('../src/http/router');
    const pairs: Array<[string, string]> = [
      ['/u/:id(\\d+)/a', '/u/:n(\\d{1,3})/:x'],
      ['/v/:a([^a-z]+)', '/v/:b(\\s)'],
      ['/w/:a([%x]{2})', '/w/:b(\\W+)'],
      ['/k/:a(\\.+)', '/k/:b([.]{2,5})'],
    ];

    for (const [a, b] of pairs) {
      const found = conflict(a, b);
      expect(found?.kind).toBe('ambiguous');
      const path = (found as { path: string }).path;
      expect([a, path, matchPattern(a, path)]).not.toContain(undefined);
      expect([b, path, matchPattern(b, path)]).not.toContain(undefined);
    }
  });
});
