/**
 * Fixed-seed route/path generator for the differential corpus.
 *
 * Its output is versioned with the fixture: `frozen/matcher-generated.json` stores the seed, the
 * rules below and every generated declaration and request. The test regenerates from the seed and
 * requires the result to equal the stored inputs, so a change to this file cannot quietly move the
 * baseline — it fails until someone deliberately starts a new generator version.
 *
 * Do not edit GENERATOR_V1. A new generator is a new version with its own frozen file.
 */
import { compilePattern } from './oracle';
import type { Declaration, Request, Scenario, Transport } from './matcher';

export const GENERATOR_SEED = 10908;
export const GENERATOR_VERSION = 'router-parity-gen-v1';

export const GENERATOR_RULES = [
  'PRNG: mulberry32(seed); every choice below draws from it in program order.',
  '40 scenarios; each has 2-10 declarations and 12 requests.',
  'Declaration: 0-3 segments, each static (a|b|c|x, p=0.5), plain param (p=0.25) or constrained param (p=0.25) ' +
    'using one of \\d+ | [a-c]+ | [0-9a-f]{2}; then a final catch-all with p=0.2. Param names are p<index>.',
  'Declaration method from GET x3, POST, PUT, DELETE, PATCH, HEAD, OPTIONS. A GET is buffer with p=0.7, else ' +
    'sse | ndjson | negotiate; every other method is buffer.',
  'Request path: p=0.6 instantiate a random declaration (static -> its literal, param -> value pool, catch-all -> ' +
    '0-2 pool values), else 0-4 random pool segments. Value pool: a b c x 7 42 ff 0a a%20b caf%C3%A9 %34%32.',
  'Request decoration: trailing slash p=0.15, a dot segment (/./ or /q/../) inserted p=0.1, a repeated slash p=0.05.',
  'Request method from GET x2, HEAD, POST, PUT, DELETE, PATCH, OPTIONS.',
  'Unsupported patterns are never produced: every generated pattern must pass compilePattern.',
];

const STATICS = ['a', 'b', 'c', 'x'];
const CONSTRAINTS = ['\\d+', '[a-c]+', '[0-9a-f]{2}'];
const VALUES = ['a', 'b', 'c', 'x', '7', '42', 'ff', '0a', 'a%20b', 'caf%C3%A9', '%34%32'];
const DECL_METHODS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
const STREAMING: Transport[] = ['sse', 'ndjson', 'negotiate'];
const REQUEST_METHODS = ['GET', 'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'];

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)];
const int = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

function patternSegment(rng: Rng, index: number): string {
  const roll = rng();
  if (roll < 0.5) return pick(rng, STATICS);
  if (roll < 0.75) return `:p${index}`;
  return `:p${index}(${pick(rng, CONSTRAINTS)})`;
}

function declaration(rng: Rng, id: string): Declaration {
  const depth = int(rng, 0, 3);
  const segments = Array.from({ length: depth }, (_, index) => patternSegment(rng, index));
  if (rng() < 0.2) segments.push(`:p${depth}*`);

  const method = pick(rng, DECL_METHODS);
  const transport: Transport = method === 'GET' && rng() >= 0.7 ? pick(rng, STREAMING) : 'buffer';
  const pattern = `/${segments.join('/')}`;
  compilePattern(pattern); // throws if a rule above ever produced an unsupported pattern
  return { id, method, pattern, transport };
}

function instantiate(rng: Rng, decl: Declaration): string[] {
  const segments: string[] = [];

  for (const segment of decl.pattern.split('/').slice(1)) {
    if (!segment) continue;
    if (segment.endsWith('*')) {
      const count = int(rng, 0, 2);
      for (let index = 0; index < count; index++) segments.push(pick(rng, VALUES));
    } else {
      segments.push(segment.startsWith(':') ? pick(rng, VALUES) : segment);
    }
  }

  return segments;
}

function decorate(rng: Rng, segments: string[]): string {
  let path = `/${segments.join('/')}`;
  if (rng() < 0.15 && path !== '/') path += '/';

  if (rng() < 0.1) {
    const at = int(rng, 0, segments.length);
    const dots = rng() < 0.5 ? ['.'] : ['q', '..'];
    const withDots = [...segments.slice(0, at), ...dots, ...segments.slice(at)];
    path = `/${withDots.join('/')}`;
  }

  if (rng() < 0.05) path = path.replace('/', '//');
  return path;
}

function request(rng: Rng, declarations: Declaration[]): Request {
  const segments =
    rng() < 0.6
      ? instantiate(rng, pick(rng, declarations))
      : Array.from({ length: int(rng, 0, 4) }, () => pick(rng, VALUES));
  return { method: pick(rng, REQUEST_METHODS), raw: decorate(rng, segments) };
}

export function generateScenarios(seed: number = GENERATOR_SEED): Scenario[] {
  const rng = mulberry32(seed);

  return Array.from({ length: 40 }, (_, index): Scenario => {
    const id = `G${String(index + 1).padStart(2, '0')}`;
    const declarations = Array.from({ length: int(rng, 2, 10) }, (_, d) => declaration(rng, `${id}.d${d + 1}`));
    const requests = Array.from({ length: 12 }, () => request(rng, declarations));
    return { id, note: `generated by ${GENERATOR_VERSION}, seed ${seed}`, declarations, requests };
  });
}
