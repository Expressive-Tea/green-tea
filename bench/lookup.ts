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
 *
 * Each implementation is a module exporting `resolveRoute` and `allowedMethods` with the
 * `src/http/router.ts` signatures. With several, every run measures all of them in separate child
 * processes, alternating which goes first, on the same generated tables. Do not edit the generator,
 * the workloads or the defaults below between a baseline and its comparison — they are the method.
 *
 * Env: `LOOKUP_ROUTERS` (label=path list, default `live=src/http/router.ts`), `LOOKUP_RUNS` (5),
 * `LOOKUP_SAMPLES` (21 per cell per run), `LOOKUP_SAMPLE_MS` (25), `LOOKUP_WARMUP_MS` (250),
 * `LOOKUP_OUT` (bench/lookup-results.json).
 */
import { spawn, execFileSync } from 'child_process';
import { writeFileSync, readFileSync } from 'fs';
import os from 'os';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';

const ROUTE_COUNTS = [10, 100, 500];
const RUNS = Number(process.env.LOOKUP_RUNS ?? 5);
const SAMPLES = Number(process.env.LOOKUP_SAMPLES ?? 21);
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
  iterations: number;
  samplesNs: number[];
}

function measure(router: RouterModule, routes: Route[], w: Workload): { iterations: number; samplesNs: number[] } {
  const answer = lookup(router, routes, w);
  if (answer !== w.expect) throw new Error(`${w.name} @ ${routes.length}: expected '${w.expect}', got '${answer}'`);

  // Warm-up, time-boxed; it also calibrates how many iterations make one sample last SAMPLE_MS.
  let sink = 0;
  let ops = 0;
  const warmStart = process.hrtime.bigint();
  const warmBudget = BigInt(WARMUP_MS * 1_000_000);
  while (process.hrtime.bigint() - warmStart < warmBudget) {
    for (let i = 0; i < 100; i++) sink += lookup(router, routes, w).length;
    ops += 100;
  }
  const nsPerOp = Number(process.hrtime.bigint() - warmStart) / ops;
  const iterations = Math.max(100, Math.round((SAMPLE_MS * 1e6) / nsPerOp));

  const samplesNs: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) sink += lookup(router, routes, w).length;
    samplesNs.push(Number(process.hrtime.bigint() - start) / iterations);
  }

  if (sink === 42) process.stderr.write(''); // keeps `sink` observable
  return { iterations, samplesNs };
}

async function child(label: string, path: string): Promise<void> {
  const router = (await import(pathToFileURL(resolve(path)).href)) as RouterModule;
  const cells: Cell[] = [];

  for (const count of ROUTE_COUNTS) {
    const routes = buildRoutes(count);
    for (const w of WORKLOADS) cells.push({ routes: count, workload: w.name, ...measure(router, routes, w) });
  }

  process.stdout.write(`${JSON.stringify({ label, cells })}\n`);
}

function runChild(label: string, path: string): Promise<{ label: string; cells: Cell[] }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'bench/lookup.ts'], {
      env: { ...process.env, LOOKUP_CHILD: `${label}=${path}` },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('exit', (code) =>
      code === 0 ? resolvePromise(JSON.parse(out)) : reject(new Error(`${label} exited ${code}`)),
    );
  });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

function environment(routers: Array<[string, string]>) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string };
  return {
    startedAt: new Date().toISOString(),
    node: process.version,
    v8: process.versions.v8,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    loadavgAtStart: os.loadavg(),
    package: `${pkg.name}@${pkg.version}`,
    harnessCommit: git('.', 'rev-parse', 'HEAD'),
    routers: routers.map(([label, path]) => ({
      label,
      path,
      commit: git(dirname(resolve(path)), 'rev-parse', 'HEAD'),
      dirty: git(dirname(resolve(path)), 'status', '--porcelain', '--', resolve(path)) !== '',
    })),
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith('LOOKUP_') || k === 'NODE_OPTIONS'),
    ),
    method: {
      routeCounts: ROUTE_COUNTS,
      routeCountMeaning: 'total registered HTTP routes',
      routeGenerator: ROUTE_GENERATOR,
      workloads: WORKLOADS,
      workloadOrder:
        'for each run: for each router (order alternates per run): for count in routeCounts: for workload in workloads',
      operation: 'resolveRoute(routes, method, path); on undefined, allowedMethods(routes, path)',
      runs: RUNS,
      samplesPerCellPerRun: SAMPLES,
      sampleMs: SAMPLE_MS,
      warmupMsPerCell: WARMUP_MS,
      unit: 'ns per lookup (sample time / iterations)',
    },
  };
}

async function main(): Promise<void> {
  if (process.env.LOOKUP_CHILD) {
    const [label, path] = process.env.LOOKUP_CHILD.split('=');
    return child(label, path);
  }

  const routers = (process.env.LOOKUP_ROUTERS ?? 'live=src/http/router.ts')
    .split(',')
    .map((entry) => entry.split('=') as [string, string]);
  const meta = environment(routers);
  const runs: Array<{ run: number; order: string[]; label: string; cells: Cell[] }> = [];

  for (let run = 0; run < RUNS; run++) {
    const order = run % 2 === 0 ? routers : [...routers].reverse();
    for (const [label, path] of order) {
      const result = await runChild(label, path);
      runs.push({ run: run + 1, order: order.map(([l]) => l), ...result });
      process.stderr.write(`[lookup] run ${run + 1}/${RUNS} ${label} done\n`);
    }
  }

  const summary = routers.flatMap(([label]) =>
    ROUTE_COUNTS.flatMap((count) =>
      WORKLOADS.map((w) => {
        const cells = runs
          .filter((r) => r.label === label)
          .map((r) => r.cells.find((c) => c.routes === count && c.workload === w.name)!);
        const runMedians = cells.map((c) => median(c.samplesNs));
        const all = cells.flatMap((c) => c.samplesNs);
        const med = median(all);
        return {
          router: label,
          routes: count,
          workload: w.name,
          medianNs: med,
          runMediansNs: runMedians,
          runSpreadPct: ((Math.max(...runMedians) - Math.min(...runMedians)) / med) * 100,
        };
      }),
    ),
  );

  const loadavgAtEnd = os.loadavg();
  writeFileSync(OUT, `${JSON.stringify({ meta: { ...meta, loadavgAtEnd }, summary, runs }, null, 2)}\n`);

  console.log('| router | routes | workload | median ns/op | run medians (ns) | run spread |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const row of summary) {
    const runsText = row.runMediansNs.map((n) => n.toFixed(1)).join(' / ');
    console.log(
      `| ${row.router} | ${row.routes} | ${row.workload} | ${row.medianNs.toFixed(1)} | ${runsText} | ${row.runSpreadPct.toFixed(1)}% |`,
    );
  }
  console.log(
    `\nload average: start ${meta.loadavgAtStart.map((n) => n.toFixed(2)).join(' ')}, end ${loadavgAtEnd.map((n) => n.toFixed(2)).join(' ')}`,
  );
  console.log(`raw samples: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
