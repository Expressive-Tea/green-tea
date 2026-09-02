/**
 * Compares green-tea against an earlier green-tea, on one box, in one sitting.
 *
 * `BENCHMARKS.md` answers "how do we compare to Fastify". This answers the question a release
 * actually has to pass: **did the last N commits cost anything.** It is a different measurement and
 * it needs a different setup, because comparing today's numbers against a table generated weeks ago
 * compares two machines-in-a-mood, not two versions.
 *
 * Usage:
 *
 *   git worktree add /tmp/base v26.8.0-beta.1
 *   ln -s "$PWD/node_modules" /tmp/base/node_modules
 *   AB_BASE=/tmp/base npm run bench:compare
 *
 * The worktree shares this checkout's `node_modules`, which is only sound while `package.json` has
 * not moved between the two revisions — check that first, or the comparison is measuring a
 * dependency bump.
 *
 * Env: `AB_BASE` (required), `AB_DURATION` (10), `AB_ROUNDS` (3), `AB_CONNS` (100),
 * `AB_ONLY` (comma-separated substrings of case names), `AB_OUT` (bench/compare-results.json).
 */
import autocannon from 'autocannon';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

const DURATION = Number(process.env.AB_DURATION ?? 10);
const ROUNDS = Number(process.env.AB_ROUNDS ?? 3);
const CONNS = Number(process.env.AB_CONNS ?? 100);

const HEAD = process.cwd();
// Per side, so "the bundle we publish vs the source we test" is one run rather than two tables.
const BASE_SERVER = process.env.AB_BASE_SERVER ?? 'compare';
const HEAD_SERVER = process.env.AB_HEAD_SERVER ?? 'compare';

function requireBase(): string {
  const base = process.env.AB_BASE;
  if (base) return base;
  console.error('AB_BASE must point at a worktree of the revision to compare against — see the header of this file.');
  process.exit(1);
}

const BASE = requireBase();

interface Case {
  name: string;
  path: string;
  method?: 'GET' | 'POST' | 'OPTIONS';
  body?: unknown;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

const ORIGIN = { origin: 'http://bench.example' };

const CASES: Case[] = [
  { name: 'hello', path: '/hello' },
  { name: 'param', path: '/users/42' },
  { name: 'pipeline (3 steps)', path: '/pipeline' },
  { name: 'steps5', path: '/steps/5' },
  { name: 'validate (POST)', path: '/validate', method: 'POST', body: { email: 'bench@example.com' } },
  { name: 'hello + security', path: '/hello', env: { GT_SECURE: '1' } },
  // The CORS predicate is only reached when a request carries an `Origin`, so a case that forgets
  // the header measures the path around it rather than the path through it.
  { name: 'hello + cors predicate', path: '/hello', env: { GT_CORS: '1' }, headers: ORIGIN },
  {
    name: 'preflight + cors predicate',
    path: '/hello',
    method: 'OPTIONS',
    env: { GT_CORS: '1' },
    headers: { ...ORIGIN, 'access-control-request-method': 'GET' },
  },
  // Route-table width. Every matcher cost scales with the number of candidates a request walks
  // past, and the cross-framework table has six routes — so a change that saves work per candidate
  // measures as noise there no matter how real it is. `/users/:id` is registered last and is not
  // all-static, so it takes the full scan rather than the early exit a literal path gets.
  { name: 'param, 50 routes', path: '/users/42', env: { GT_ROUTES: '50' } },
  { name: 'param, 200 routes', path: '/users/42', env: { GT_ROUTES: '200' } },
];

const ONLY = process.env.AB_ONLY;
const RUN_CASES = ONLY ? CASES.filter((c) => ONLY.split(',').some((k) => c.name.includes(k.trim()))) : CASES;

function log(m: string): void {
  process.stderr.write(`[compare] ${m}\n`);
}

async function boot(cwd: string, env: Record<string, string>, server = 'compare'): Promise<{ port: number; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', `bench/servers/${server}.ts`], {
    cwd,
    env: { ...process.env, TSX_TSCONFIG_PATH: 'bench/tsconfig.json', ...env },
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no READY in 15s:\n${stderr}`));
    }, 15000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /READY (\d+)/.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (c) => {
      clearTimeout(t);
      reject(new Error(`exited ${c}:\n${stderr}`));
    });
  });
  const kill = (): Promise<void> =>
    new Promise<void>((r) => {
      child.on('exit', () => r());
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 2000);
    });
  return { port, kill };
}

async function hit(port: number, c: Case, warmup = false): Promise<number> {
  const r = (await autocannon({
    url: `http://127.0.0.1:${port}${c.path}`,
    connections: CONNS,
    duration: DURATION,
    pipelining: 1,
    method: (c.method ?? 'GET') as 'GET',
    headers: { ...(c.body ? { 'content-type': 'application/json' } : {}), ...c.headers },
    body: c.body ? JSON.stringify(c.body) : undefined,
  })) as unknown as {
    requests: { average: number };
    non2xx?: number;
    errors?: number;
    timeouts?: number;
  };

  // A case whose route 404s still posts a req/s number, and a run whose connections all errored
  // posts one too — 0, which a median will quietly absorb. Assert the traffic was the traffic this
  // case claims to send before believing any of it.
  // Not on the warmup: a cold server drops a handful of connections from the opening burst, and
  // absorbing exactly that is what the warmup is for. Asserting on it fails the run for the noise
  // it exists to discard.
  if (!warmup) {
    const bad = (r.non2xx ?? 0) + (r.errors ?? 0) + (r.timeouts ?? 0);
    if (bad > 0) throw new Error(`${c.name}: ${bad} non-2xx/error/timeout responses — not measuring what it claims`);
    if (!(r.requests.average > 0)) throw new Error(`${c.name}: 0 req/s — the run produced no traffic`);
  }

  return r.requests.average;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * True when the two sides' sample ranges do not overlap at all.
 *
 * A weak signal on its own and stated as such: with three samples a pair of overlapping
 * distributions separates by chance often enough to fool you, which it did the first time this was
 * run. Treat a flagged row as "measure it again with more rounds", never as a result.
 */
const separated = (a: number[], b: number[]): boolean => {
  const [x, y] = [[...a].sort((p, q) => p - q), [...b].sort((p, q) => p - q)];
  return x[0] > y[y.length - 1] || y[0] > x[x.length - 1];
};

/**
 * Counts `cors.origins` invocations for one cross-origin GET and one preflight.
 *
 * Deliberately a count rather than a rate: the benchmark's predicate is a `Set.has`, so calls saved
 * are invisible in req/s — but the option takes a function so it can be a lookup, and there the
 * same saving is a network round trip.
 */
async function corsCalls(cwd: string, server: string): Promise<{ get: number; preflight: number }> {
  const { port, kill } = await boot(cwd, { GT_CORS: '1' }, server);
  const base = `http://127.0.0.1:${port}`;
  // The read carries no `Origin`, so asking cannot change the answer.
  const read = async (): Promise<number> => ((await (await fetch(`${base}/cors-calls`)).json()) as { calls: number }).calls;

  try {
    const before = await read();
    await fetch(`${base}/hello`, { headers: ORIGIN });
    const afterGet = await read();
    await fetch(`${base}/hello`, { method: 'OPTIONS', headers: { ...ORIGIN, 'access-control-request-method': 'GET' } });
    const afterPreflight = await read();
    return { get: afterGet - before, preflight: afterPreflight - afterGet };
  } finally {
    await kill();
  }
}

async function main(): Promise<void> {
  const samples: Record<string, { base: number[]; head: number[] }> = {};
  for (const c of RUN_CASES) samples[c.name] = { base: [], head: [] };

  for (let round = 0; round < ROUNDS; round++) {
    // Alternate which side goes first. Thermal drift and background load over a half-hour run are
    // real; alternating spreads them across both sides instead of charging them to whichever went
    // second.
    const order: Array<['base' | 'head', string]> =
      round % 2 === 0
        ? [
            ['base', BASE],
            ['head', HEAD],
          ]
        : [
            ['head', HEAD],
            ['base', BASE],
          ];

    for (const [side, cwd] of order) {
      for (const c of RUN_CASES) {
        const { port, kill } = await boot(cwd, c.env ?? {}, side === 'base' ? BASE_SERVER : HEAD_SERVER);
        try {
          await hit(port, c, true); // warmup, discarded
          const v = await hit(port, c);
          samples[c.name][side].push(v);
          log(`round ${round + 1} ${side.padEnd(4)} ${c.name.padEnd(28)} ${Math.round(v).toLocaleString()} req/s`);
        } finally {
          await kill();
        }
      }
    }
  }

  const rows = RUN_CASES.map((c) => {
    const b = median(samples[c.name].base);
    const h = median(samples[c.name].head);
    return {
      name: c.name,
      base: b,
      head: h,
      delta: ((h - b) / b) * 100,
      separated: separated(samples[c.name].base, samples[c.name].head),
      samples: samples[c.name],
    };
  });

  const cors = { base: await corsCalls(BASE, BASE_SERVER), head: await corsCalls(HEAD, HEAD_SERVER) };

  writeFileSync(
    process.env.AB_OUT ?? 'bench/compare-results.json',
    JSON.stringify({ rounds: ROUNDS, duration: DURATION, conns: CONNS, rows, cors }, null, 2),
  );

  const f = (n: number): string => Math.round(n).toLocaleString();
  console.log('\n| Scenario | base | head | Δ | |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const r of rows) {
    const flag = r.separated ? 'ranges do not overlap — re-run with more rounds' : 'overlaps';
    console.log(`| ${r.name} | ${f(r.base)} | ${f(r.head)} | ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}% | ${flag} |`);
  }
  console.log(`\ncors.origins calls — base: ${cors.base.get} per GET, ${cors.base.preflight} per preflight`);
  console.log(`cors.origins calls — head: ${cors.head.get} per GET, ${cors.head.preflight} per preflight`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
