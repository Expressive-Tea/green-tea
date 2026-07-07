import autocannon from 'autocannon';
import { spawn, execSync } from 'child_process';
import os from 'os';
import { writeFileSync } from 'fs';
import { SCENARIOS, STEP_ROUTES } from './scenarios';
import { aggregate } from './stats';
import { renderMarkdown, type RenderData, type Row, type ScenarioBlock } from './render';

const SMOKE = process.env.BENCH_SMOKE === '1';
const CONNS = Number(process.env.BENCH_CONNS ?? 100);
const DURATION = SMOKE ? 1 : Number(process.env.BENCH_DURATION ?? 10);
const RUNS = SMOKE ? 1 : Number(process.env.BENCH_RUNS ?? 5);
const WARMUP = SMOKE ? 0 : Number(process.env.BENCH_WARMUP ?? 1);

function log(msg: string): void {
  process.stderr.write(`[bench] ${msg}\n`);
}

interface RunResult {
  reqSec: number;
  p50: number;
  p99: number;
  p999: number;
}

async function spawnServer(
  name: string,
  extraEnv: Record<string, string> = {},
): Promise<{ port: number; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', `bench/servers/${name}.ts`], {
    env: { ...process.env, TSX_TSCONFIG_PATH: 'bench/tsconfig.json', ...extraEnv },
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${name} failed to boot (no READY in 10s):\n${stderr}`));
    }, 10000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /READY (\d+)/.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`${name} exited early (code ${code}):\n${stderr}`));
    });
  });
  const kill = (): Promise<void> =>
    new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
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

async function bench(port: number, path: string, method: 'GET' | 'POST', body?: unknown): Promise<RunResult> {
  const r: any = await autocannon({
    url: `http://127.0.0.1:${port}${path}`,
    connections: CONNS,
    duration: DURATION,
    pipelining: 1,
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { reqSec: r.requests.average, p50: r.latency.p50, p99: r.latency.p99, p999: r.latency.p99_9 };
}

async function measure(port: number, path: string, method: 'GET' | 'POST', body?: unknown): Promise<RunResult[]> {
  for (let i = 0; i < WARMUP; i++) await bench(port, path, method, body); // discarded
  const runs: RunResult[] = [];
  for (let i = 0; i < RUNS; i++) runs.push(await bench(port, path, method, body));
  return runs;
}

async function main(): Promise<void> {
  const frameworks = ['raw-http', 'fastify', 'express', 'green-tea'];
  const scenarioBlocks: ScenarioBlock[] = SCENARIOS.map((s) => ({
    title: s.title,
    name: s.name,
    approximation: s.approximation,
    rows: [],
  }));
  const stepScaling: RenderData['stepScaling'] = [];
  const secureCost: RenderData['secureCost'] = [];

  for (const fw of frameworks) {
    log(`booting ${fw}`);
    const { port, kill } = await spawnServer(fw);
    try {
      for (const s of SCENARIOS) {
        log(`${fw} / ${s.name}`);
        const runs = await measure(port, s.path, s.method, s.body);
        const agg = aggregate(runs.map((r) => r.reqSec));
        const last = runs[runs.length - 1];
        const row: Row = {
          framework: fw,
          reqSec: { median: agg.median, min: agg.min, max: agg.max, stddev: agg.stddev, cv: agg.cv },
          p50: last.p50,
          p99: last.p99,
          p999: last.p999,
        };
        scenarioBlocks.find((b) => b.name === s.name)!.rows.push(row);
      }
      if (fw === 'green-tea') {
        for (const sr of STEP_ROUTES) {
          const runs = await measure(port, sr.path, 'GET');
          stepScaling.push({ path: sr.path, steps: sr.steps, reqSec: aggregate(runs.map((r) => r.reqSec)).median });
        }
        secureCost.push({
          label: 'security:false (parity)',
          reqSec: aggregate((await measure(port, '/hello', 'GET')).map((r) => r.reqSec)).median,
        });
      }
    } finally {
      await kill();
    }
  }

  log('booting green-tea (GT_SECURE=1)');
  {
    const { port, kill } = await spawnServer('green-tea', { GT_SECURE: '1' });
    try {
      secureCost.push({
        label: 'security:true (default)',
        reqSec: aggregate((await measure(port, '/hello', 'GET')).map((r) => r.reqSec)).median,
      });
    } finally {
      await kill();
    }
  }

  const commit = execSync('git rev-parse --short HEAD').toString().trim();
  const data: RenderData = {
    env: {
      date: new Date().toISOString().slice(0, 10),
      commit,
      node: process.version,
      os: os.platform(),
      cpu: `${os.cpus()[0].model} (${os.cpus().length} cores)`,
      ram: `${Math.round(os.totalmem() / 1e9)} GB`,
      pinned: false,
    },
    config: { conns: CONNS, duration: DURATION, runs: RUNS, warmup: WARMUP, pipelining: 1 },
    scenarios: scenarioBlocks,
    stepScaling,
    secureCost,
  };
  writeFileSync('BENCHMARKS.md', renderMarkdown(data));
  writeFileSync('bench/results.json', JSON.stringify(data, null, 2));
  log('wrote BENCHMARKS.md + bench/results.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
