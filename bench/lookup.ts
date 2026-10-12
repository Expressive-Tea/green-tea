/**
 * Focused route-lookup benchmark — the D4 instrument for the radix router (FPRD-001 CARD-08/10, #109).
 *
 * `bench:compare` measures req/s end to end, where lookup is a few percent of a request and drowns
 * in socket and pipeline noise. This measures the lookup alone: exactly what `dispatch` in
 * `src/http/core.ts` does with an already-normalized path — `resolveRoute`, and on a miss
 * `allowedMethods` for the 404/405 decision. Normalization is excluded: CARD-07 does not touch it.
 *
 * Usage:
 *
 *   npm run bench:lookup
 *   LOOKUP_ROUTERS="base=/tmp/base/src/http/router.ts,head=src/http/router.ts" npm run bench:lookup
 *   LOOKUP_ROUTERS="live=src/http/router.ts,oracle=test/router-parity/oracle.ts" npm run bench:lookup   # A/A
 *
 * Each router is a module exporting `resolveRoute` and `allowedMethods` with the `src/http/router.ts`
 * signatures. All routers are loaded into the same process and **interleaved**: per cell, every
 * router is warmed, then each round takes one sample from each router, alternating which goes first
 * (AB, BA, AB, ...). Fresh processes alternate the whole router order, warm-up included. Every router after the first is reported against the first as the median of the
 * per-round B/A ratios, with a bootstrap 95% CI. Interleaving puts drift and background load on both
 * sides of each ratio instead of on whichever ran later. With one router it reports absolute numbers
 * only. Do not edit the generator, the workloads or the defaults between a baseline and its
 * comparison: they are the method.
 *
 * Env: `LOOKUP_ROUTERS` (label=path list, default `live=src/http/router.ts`), `LOOKUP_RUNS` (4 fresh
 * processes, router order alternating), `LOOKUP_ROUNDS` (21 per cell per run, minimum 15), `LOOKUP_SAMPLE_MS` (25),
 * `LOOKUP_WARMUP_MS` (250 per router per cell), `LOOKUP_OUT` (bench/lookup-results.json). Any other
 * `LOOKUP_*` variable (e.g. `LOOKUP_HOST`, `LOOKUP_CPUSET`) is copied into the record as a note.
 */
import { spawn, execFileSync } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import os from 'os';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';

const ROUTE_COUNTS = [10, 100, 500];
const RUNS = Number(process.env.LOOKUP_RUNS ?? 4);
const ROUNDS = Math.max(15, Number(process.env.LOOKUP_ROUNDS ?? 21));
const BOOTSTRAP = 4000;
const SAMPLE_MS = Number(process.env.LOOKUP_SAMPLE_MS ?? 25);
const WARMUP_MS = Number(process.env.LOOKUP_WARMUP_MS ?? 250);
const OUT = process.env.LOOKUP_OUT ?? 'bench/lookup-results.json';

interface Route {
  method: string;
  pattern: string;
  transport: 'buffer';
  handler: () => Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

interface RouterModule {
  resolveRoute(routes: Route[], method: string, path: string): { def: Route } | undefined;
  allowedMethods(routes: Route[], path: string): string[];
}

/** Five REST-shaped filler routes per resource, cycled, so every count has statics, params, constraints and catch-alls. */
const FILLER: Array<(k: number) => [string, string]> = [
  (k) => ['GET', `/res${k}/items`],
  (k) => ['POST', `/res${k}/items`],
  (k) => ['GET', `/res${k}/items/:id`],
  (k) => ['PUT', `/res${k}/items/:id(\\d+)`],
  (k) => ['GET', `/res${k}/files/:path*`],
];

export const ROUTE_GENERATOR =
  'N total HTTP routes: N-2 fillers (i = 0..N-3, shape FILLER[i % 5] with k = floor(i / 5): GET /res{k}/items, ' +
  'POST /res{k}/items, GET /res{k}/items/:id, PUT /res{k}/items/:id(\\d+), GET /res{k}/files/:path*), then ' +
  'GET /static/target/leaf, then GET /late/:group/:id declared last. All buffer transport.';

const handler = async () => ({ status: 200, headers: {}, body: '' });

export function buildRoutes(total: number): Route[] {
  const fillers = Array.from({ length: total - 2 }, (_, i): Route => {
    const [method, pattern] = FILLER[i % FILLER.length](Math.floor(i / FILLER.length));
    return { method, pattern, transport: 'buffer', handler };
  });
  return [
    ...fillers,
    { method: 'GET', pattern: '/static/target/leaf', transport: 'buffer', handler },
    { method: 'GET', pattern: '/late/:group/:id', transport: 'buffer', handler },
  ];
}

interface Workload {
  name: string;
  method: string;
  path: string;
  /** What the lookup must answer; checked before timing, so a broken implementation cannot post a number. */
  expect: string;
}

export const WORKLOADS: Workload[] = [
  { name: 'static hit', method: 'GET', path: '/static/target/leaf', expect: 'hit /static/target/leaf' },
  { name: 'late param hit', method: 'GET', path: '/late/g1/42', expect: 'hit /late/:group/:id' },
  { name: 'method miss', method: 'DELETE', path: '/static/target/leaf', expect: 'allow GET,HEAD,OPTIONS' },
  { name: 'path miss', method: 'GET', path: '/nowhere/at/all', expect: 'allow ' },
];

/** One lookup, as `dispatch` performs it. Returns a value so the work cannot be optimised away. */
function lookup(router: RouterModule, routes: Route[], w: Workload): string {
  const matched = router.resolveRoute(routes, w.method, w.path);
  if (matched) return `hit ${matched.def.pattern}`;
  return `allow ${router.allowedMethods(routes, w.path).join(',')}`;
}

interface Cell {
  routes: number;
  workload: string;
  /** Calibrated per router; a sample is `iterations` lookups. */
  iterations: Record<string, number>;
  /** Round order, e.g. ['live', 'oracle'] then ['oracle', 'live']. */
  orders: string[][];
  /** One entry per router, one sample (ns per lookup) per round, in round order. */
  samplesNs: Record<string, number[]>;
}

type Loaded = Array<{ label: string; router: RouterModule }>;

let sink = 0;

function warm(router: RouterModule, routes: Route[], w: Workload): number {
  const answer = lookup(router, routes, w);
  if (answer !== w.expect) throw new Error(`${w.name} @ ${routes.length}: expected '${w.expect}', got '${answer}'`);

  // Time-boxed; it also calibrates how many iterations make one sample last SAMPLE_MS.
  let ops = 0;
  const warmStart = process.hrtime.bigint();
  const warmBudget = BigInt(WARMUP_MS * 1_000_000);
  while (process.hrtime.bigint() - warmStart < warmBudget) {
    for (let i = 0; i < 100; i++) sink += lookup(router, routes, w).length;
    ops += 100;
  }
  const nsPerOp = Number(process.hrtime.bigint() - warmStart) / ops;
  return Math.max(100, Math.round((SAMPLE_MS * 1e6) / nsPerOp));
}

function sample(router: RouterModule, routes: Route[], w: Workload, iterations: number): number {
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) sink += lookup(router, routes, w).length;
  return Number(process.hrtime.bigint() - start) / iterations;
}

function measureCell(loaded: Loaded, routes: Route[], w: Workload): Cell {
  const iterations: Record<string, number> = {};
  const samplesNs: Record<string, number[]> = {};
  const orders: string[][] = [];

  for (const { label, router } of loaded) {
    iterations[label] = warm(router, routes, w);
    samplesNs[label] = [];
  }

  for (let round = 0; round < ROUNDS; round++) {
    const order = round % 2 === 0 ? loaded : [...loaded].reverse();
    orders.push(order.map(({ label }) => label));
    for (const { label, router } of order) samplesNs[label].push(sample(router, routes, w, iterations[label]));
  }

  return { routes: routes.length, workload: w.name, iterations, orders, samplesNs };
}

async function child(routers: Array<[string, string]>): Promise<void> {
  // Router order alternates per run (LOOKUP_IMPORT_REVERSED): import order, warm-up order and which
  // router opens each cell's first round. Whichever router V8 sees first, in import or in the shared
  // `lookup` call site, can bias an in-process comparison of otherwise identical code; alternating
  // all of it spreads that over both sides. Reversing only the import order left an A/A bias of up
  // to +8% on the second-listed router (CARD-10).
  const ordered = process.env.LOOKUP_IMPORT_REVERSED === '1' ? [...routers].reverse() : routers;
  const loaded: Loaded = [];
  for (const [label, path] of ordered)
    loaded.push({ label, router: (await import(pathToFileURL(resolve(path)).href)) as RouterModule });

  const cells: Cell[] = [];
  for (const count of ROUTE_COUNTS) {
    const routes = buildRoutes(count);
    for (const w of WORKLOADS) cells.push(measureCell(loaded, routes, w));
  }

  if (sink === 42) process.stderr.write(''); // keeps `sink` observable
  process.stdout.write(`${JSON.stringify({ cells })}\n`);
}

function runChild(spec: string, importReversed: boolean): Promise<{ cells: Cell[] }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'bench/lookup.ts'], {
      env: { ...process.env, LOOKUP_CHILD: spec, LOOKUP_IMPORT_REVERSED: importReversed ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('exit', (code) =>
      code === 0 ? resolvePromise(JSON.parse(out)) : reject(new Error(`child exited ${code}`)),
    );
  });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Deterministic PRNG for the bootstrap, so the same raw samples always give the same interval. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap 95% CI of the median of `xs`. */
function bootstrapMedianCi(xs: number[]): [number, number] {
  const rng = mulberry32(10908);
  const medians: number[] = [];
  for (let b = 0; b < BOOTSTRAP; b++) medians.push(median(xs.map(() => xs[Math.floor(rng() * xs.length)])));
  medians.sort((a, b) => a - b);
  return [medians[Math.floor(BOOTSTRAP * 0.025)], medians[Math.ceil(BOOTSTRAP * 0.975) - 1]];
}

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unavailable';
  }
}

function cpuset(): string {
  for (const file of ['/sys/fs/cgroup/cpuset.cpus.effective', '/sys/fs/cgroup/cpuset/cpuset.effective_cpus']) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      /* not Linux, or not this cgroup layout */
    }
  }
  return 'n/a';
}

function environment(routers: Array<[string, string]>) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string };
  return {
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
    node: process.version,
    v8: process.versions.v8,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    cpuset: cpuset(),
    memoryBytes: os.totalmem(),
    loadavgAtStart: os.loadavg(),
    package: `${pkg.name}@${pkg.version}`,
    harnessCommit: process.env.LOOKUP_COMMIT ?? git('.', 'rev-parse', 'HEAD'),
    routers: routers.map(([label, path]) => ({ label, path })),
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith('LOOKUP_') || k === 'NODE_OPTIONS'),
    ),
    method: {
      routeCounts: ROUTE_COUNTS,
      routeCountMeaning: 'total registered HTTP routes',
      routeGenerator: ROUTE_GENERATOR,
      workloads: WORKLOADS,
      workloadOrder:
        'for each run (fresh process; module import order reversed on even-numbered runs): for count in routeCounts: ' +
        'for workload in workloads: warm every router, ' +
        'then ROUNDS rounds of one sample per router, order alternating AB/BA per round',
      operation: 'resolveRoute(routes, method, path); on undefined, allowedMethods(routes, path)',
      runs: RUNS,
      roundsPerCellPerRun: ROUNDS,
      sampleMs: SAMPLE_MS,
      warmupMsPerRouterPerCell: WARMUP_MS,
      ratio: 'per round, sample(B) / sample(A) with A the first router; median over all rounds of all runs',
      ci: `percentile bootstrap of the median ratio, ${BOOTSTRAP} resamples, seed 10908`,
      unit: 'ns per lookup (sample time / iterations)',
    },
  };
}

function summarize(labels: string[], runs: Array<{ run: number; cells: Cell[] }>) {
  return ROUTE_COUNTS.flatMap((count) =>
    WORKLOADS.map((w) => {
      const cells = runs.map((r) => r.cells.find((c) => c.routes === count && c.workload === w.name)!);
      const routers = labels.map((label) => {
        const runMedians = cells.map((c) => median(c.samplesNs[label]));
        const med = median(cells.flatMap((c) => c.samplesNs[label]));
        return {
          router: label,
          medianNs: med,
          runMediansNs: runMedians,
          runSpreadPct: ((Math.max(...runMedians) - Math.min(...runMedians)) / med) * 100,
        };
      });
      const ratios = labels.slice(1).map((label) => {
        const paired = cells.flatMap((c) => c.samplesNs[label].map((b, i) => b / c.samplesNs[labels[0]][i]));
        const [low, high] = bootstrapMedianCi(paired);
        return { b: label, a: labels[0], medianRatio: median(paired), ci95: [low, high], rounds: paired.length };
      });
      return { routes: count, workload: w.name, routers, ratios };
    }),
  );
}

const pct = (ratio: number): string => `${ratio >= 1 ? '+' : ''}${((ratio - 1) * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const spec = process.env.LOOKUP_CHILD
    ? process.env.LOOKUP_CHILD
    : (process.env.LOOKUP_ROUTERS ?? 'live=src/http/router.ts');
  const routers = spec.split(',').map((entry) => entry.split('=') as [string, string]);
  if (process.env.LOOKUP_CHILD) return child(routers);

  const labels = routers.map(([label]) => label);
  const meta = environment(routers);
  const runs: Array<{ run: number; importReversed: boolean; cells: Cell[] }> = [];

  for (let run = 0; run < RUNS; run++) {
    runs.push({ run: run + 1, importReversed: run % 2 === 1, ...(await runChild(spec, run % 2 === 1)) });
    process.stderr.write(`[lookup] run ${run + 1}/${RUNS} done\n`);
  }

  const summary = summarize(labels, runs);
  const loadavgAtEnd = os.loadavg();
  writeFileSync(OUT, `${JSON.stringify({ meta: { ...meta, loadavgAtEnd }, summary, runs }, null, 2)}\n`);

  console.log('| routes | workload | router | median ns/op | run medians (ns) | run spread |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const cell of summary)
    for (const r of cell.routers)
      console.log(
        `| ${cell.routes} | ${cell.workload} | ${r.router} | ${r.medianNs.toFixed(1)} | ` +
          `${r.runMediansNs.map((n) => n.toFixed(1)).join(' / ')} | ${r.runSpreadPct.toFixed(1)}% |`,
      );

  if (labels.length > 1) {
    console.log('\n| routes | workload | B / A | median ratio | 95% CI | rounds |');
    console.log('| --- | --- | --- | --- | --- | --- |');
    for (const cell of summary)
      for (const r of cell.ratios)
        console.log(
          `| ${cell.routes} | ${cell.workload} | ${r.b} / ${r.a} | ${r.medianRatio.toFixed(4)} (${pct(r.medianRatio)}) | ` +
            `${r.ci95.map((x) => x.toFixed(4)).join(' – ')} (${pct(r.ci95[0])} … ${pct(r.ci95[1])}) | ${r.rounds} |`,
        );
  }

  console.log(
    `\nload average: start ${meta.loadavgAtStart.map((n) => n.toFixed(2)).join(' ')}, ` +
      `end ${loadavgAtEnd.map((n) => n.toFixed(2)).join(' ')}; cpuset ${meta.cpuset}`,
  );
  console.log(`raw samples: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
