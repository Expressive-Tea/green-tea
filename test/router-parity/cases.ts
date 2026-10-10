/**
 * Hand-picked matcher scenarios (ROUTER-CORPUS §2). Declaration IDs are stable across a scenario
 * and its reversed twin, so a reversed run is compared by which declaration answered, not by which
 * pattern text happens to sit first.
 *
 * Inputs only. The expected outputs live in `frozen/matcher-hand.json`, captured from the pinned
 * revision; nothing in this file states what the answer should be.
 */
import type { Declaration, Request, Scenario, Transport } from './matcher';

type Decl = [id: string, method: string, pattern: string, transport?: Transport];
type Req = [method: string, raw: string];

function scenario(id: string, note: string, decls: Decl[], reqs: Req[]): Scenario {
  const declarations = decls.map(([declId, method, pattern, transport = 'buffer']): Declaration => ({
    id: declId,
    method,
    pattern,
    transport,
  }));
  const requests = reqs.map(([method, raw]): Request => ({ method, raw }));
  return { id, note, declarations, requests };
}

/** The same scenario with its declarations in reverse registration order. */
function reversed(base: Scenario, id: string): Scenario {
  return { ...base, id, note: `${base.note} (declarations reversed)`, declarations: [...base.declarations].reverse() };
}

const get = (...paths: string[]): Req[] => paths.map((path): Req => ['GET', path]);
const methods = (path: string, ...verbs: string[]): Req[] => verbs.map((verb): Req => [verb, path]);

const rank = scenario(
  'H01-rank',
  'static beats plain param beats catch-all',
  [
    ['catchAll', 'GET', '/a/:rest*'],
    ['param', 'GET', '/a/:id'],
    ['static', 'GET', '/a/b'],
  ],
  [...get('/a/b', '/a/x', '/a/x/y', '/a', '/a/'), ['HEAD', '/a/x'], ['OPTIONS', '/a/b'], ['POST', '/a/b']],
);

const constraint = scenario(
  'H03-constraint',
  'constrained param beats plain param; constraint tested against the decoded segment',
  [
    ['plain', 'GET', '/users/:value'],
    ['digits', 'GET', '/users/:id(\\d+)'],
  ],
  get('/users/42', '/users/alice', '/users/42x', '/users/%34%32', '/users/'),
);

const constraintTie = scenario(
  'H05-constraint-tie',
  'two overlapping constraints of equal rank: registration order decides',
  [
    ['digits', 'GET', '/n/:num(\\d+)'],
    ['hex', 'GET', '/n/:code([0-9a-f]+)'],
  ],
  get('/n/42', '/n/ff', '/n/4f', '/n/zz'),
);

const equalRank = scenario(
  'H08-equal-rank',
  'equal-specificity plain params: first registered wins',
  [
    ['first', 'GET', '/t/:first'],
    ['second', 'GET', '/t/:second'],
  ],
  [...get('/t/x', '/t/x/y'), ['HEAD', '/t/x']],
);

const samePattern = scenario(
  'H10-same-pattern',
  'identical pattern text under two declaration IDs (mesh local/remote twins reach the matcher this way)',
  [
    ['one', 'GET', '/same'],
    ['two', 'GET', '/same'],
  ],
  [...get('/same'), ['HEAD', '/same'], ['OPTIONS', '/same']],
);

export const HAND_SCENARIOS: Scenario[] = [
  rank,
  reversed(rank, 'H02-rank-reversed'),
  constraint,
  reversed(constraint, 'H04-constraint-reversed'),
  constraintTie,
  reversed(constraintTie, 'H06-constraint-tie-reversed'),
  scenario(
    'H07-exact-vs-catch-all',
    'exact route at /files, catch-all below it, decoded captures',
    [
      ['exact', 'GET', '/files'],
      ['rest', 'GET', '/files/:rest*'],
    ],
    [...get('/files', '/files/', '/files/a%2Fb', '/files/a/b/c', '/files/a%20b/c%2Fd'), ['HEAD', '/files/x']],
  ),
  equalRank,
  reversed(equalRank, 'H09-equal-rank-reversed'),
  samePattern,
  reversed(samePattern, 'H11-same-pattern-reversed'),
  scenario(
    'H12-method-implicit-head',
    'buffered GET supplies HEAD; OPTIONS and 405 share one canonical Allow',
    [
      ['get', 'GET', '/m'],
      ['post', 'POST', '/m'],
    ],
    methods('/m', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH'),
  ),
  scenario(
    'H13-method-explicit-head',
    'an explicit HEAD wins over the buffered-GET fallback',
    [
      ['get', 'GET', '/m'],
      ['post', 'POST', '/m'],
      ['head', 'HEAD', '/m'],
    ],
    methods('/m', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE'),
  ),
  scenario(
    'H14-streaming-head',
    'a streaming GET does not supply HEAD',
    [['stream', 'GET', '/stream', 'sse']],
    methods('/stream', 'GET', 'HEAD', 'OPTIONS', 'POST'),
  ),
  scenario(
    'H15-streaming-outranks-buffered',
    'HEAD skips a higher-ranked streaming GET and falls back to a lower-ranked buffered GET',
    [
      ['live', 'GET', '/s/live', 'sse'],
      ['byId', 'GET', '/s/:id'],
    ],
    [...methods('/s/live', 'GET', 'HEAD', 'OPTIONS'), ['HEAD', '/s/x']],
  ),
  scenario(
    'H16-negotiate-and-ndjson-head',
    'negotiate and ndjson GETs are streaming transports for the HEAD rule',
    [
      ['negotiate', 'GET', '/neg', 'negotiate'],
      ['ndjson', 'GET', '/nd', 'ndjson'],
    ],
    [...methods('/neg', 'GET', 'HEAD', 'OPTIONS'), ...methods('/nd', 'HEAD', 'OPTIONS')],
  ),
  scenario(
    'H17-allow-order',
    'Allow is canonical regardless of declaration order; explicit OPTIONS is a normal route',
    [
      ['delete', 'DELETE', '/r'],
      ['patch', 'PATCH', '/r'],
      ['options', 'OPTIONS', '/r'],
      ['put', 'PUT', '/r'],
      ['get', 'GET', '/r', 'sse'],
      ['post', 'POST', '/r'],
    ],
    methods('/r', 'OPTIONS', 'HEAD', 'GET', 'TRACE', 'POST'),
  ),
  scenario(
    'H18-path-miss',
    'a path no pattern matches: no route and an empty Allow',
    [['a', 'GET', '/a']],
    [...get('/absent', '/a/extra', '/'), ['OPTIONS', '/absent'], ['HEAD', '/absent']],
  ),
  scenario(
    'H19-encoding-case-unicode',
    'decoded params, malformed escapes, repeated slashes, exact case and Unicode literals',
    [
      ['userId', 'GET', '/users/:id'],
      ['upper', 'GET', '/Case'],
      ['unicode', 'GET', '/café'],
      ['unicodeParam', 'GET', '/u/:name'],
    ],
    get(
      '/users/a%20b',
      '/users/a+b',
      '/users/%F0%9F%8D%B5',
      '/users/%E0%A4%A',
      '/users/%zz',
      '/a//b',
      '/users//x',
      '/Case',
      '/case',
      '/CASE',
      '/café',
      '/caf%C3%A9',
      '/u/caf%C3%A9',
      '/u/café',
    ),
  ),
  scenario(
    'H20-normalization',
    'one trailing slash removed; plain and encoded dot segments resolved before lookup',
    [
      ['a', 'GET', '/a'],
      ['admin', 'GET', '/admin'],
      ['file', 'GET', '/public/:file'],
    ],
    get(
      '/a/',
      '/a//',
      '/public/../admin',
      '/public/%2e%2e/admin',
      '/public/%2E%2E/admin',
      '/public/./x',
      '/a/.',
      '/public/..%2fadmin',
      '/..',
      '/a/b/../../admin',
      '',
      'a',
    ),
  ),
  scenario(
    'H21-root',
    'the root pattern and a root catch-all',
    [
      ['any', 'GET', '/:rest*'],
      ['root', 'GET', '/'],
    ],
    get('/', '/x', '/x/y', '/x/'),
  ),
  scenario(
    'H22-first-differing-segment',
    'ranking is decided at the first segment whose kind differs',
    [
      ['paramStatic', 'GET', '/a/:x/c'],
      ['staticParam', 'GET', '/a/b/:y'],
      ['paramConstrained', 'GET', '/a/:x/:y(\\d+)'],
    ],
    get('/a/b/c', '/a/z/c', '/a/z/5', '/a/b/5', '/a/z/q'),
  ),
  scenario(
    'H23-per-position-decode',
    'a decoded value is the same for every candidate the scan reaches',
    [
      ['zzz', 'GET', '/a/:x/zzz'],
      ['b', 'GET', '/a/:y/b'],
    ],
    get('/a/a%20b/b', '/a/a%20b/zzz'),
  ),
  scenario(
    'H24-constrained-catch-all',
    'two catch-alls ranked by the segments before them',
    [
      ['named', 'GET', '/v/:name/:rest*'],
      ['versioned', 'GET', '/v/:ver(\\d+)/:rest*'],
    ],
    get('/v/1/x', '/v/a/x', '/v/1', '/v'),
  ),
];
