/**
 * Soak job (#80): drives `bench/servers/soak.mts` (built `dist/`) with a fixed mix for SOAK_SECONDS
 * (default 120): autocannon on a JSON route, SSE and WebSocket connections opened and dropped in a
 * loop, and one SSE subscriber on a busy channel that never reads. Samples RSS, heap and handles
 * every 5 s, then sends SIGTERM while traffic still flows.
 *
 * Fails on: heap growth between the first and last third of the run (> 25% and > 8 MB, after gc),
 * any unhandled rejection in the server, or a close() under load that does not exit 0 within 20 s.
 * Run `npm run build` first.
 */
import autocannon from 'autocannon';
import { spawn } from 'child_process';

const SECONDS = Number(process.env.SOAK_SECONDS ?? 120);
const child = spawn(process.execPath, ['--expose-gc', '--import', 'tsx', 'bench/servers/soak.mts'], {
  env: { ...process.env, TSX_TSCONFIG_PATH: 'bench/tsconfig.json' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const exited = new Promise<number | null>((r) => child.on('exit', r));
const port = await new Promise<number>((resolve, reject) => {
  child.stdout.on('data', (d: Buffer) => {
    const m = /READY (\d+)/.exec(String(d));
    if (m) resolve(Number(m[1]));
  });
  setTimeout(() => reject(new Error('soak server did not start in 15 s')), 15_000).unref();
});
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let stop = false;

interface Mem { rss: number; heapUsed: number; handles: number; unhandled: number }
const mem = async (): Promise<Mem> => (await fetch(`${base}/__mem`)).json() as Promise<Mem>;

async function sseChurn(): Promise<void> {
  while (!stop) {
    const ac = new AbortController();
    const res = await fetch(`${base}/ticks`, { signal: ac.signal }).catch(() => null);
    const reader = res?.body?.getReader();
    for (let i = 0; i < 5 && reader; i++) await reader.read().catch(() => {});
    ac.abort();
  }
}

async function wsChurn(): Promise<void> {
  while (!stop) {
    await new Promise<void>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/echo`);
      let got = 0;
      ws.onopen = () => { for (let i = 0; i < 10; i++) ws.send(`m${i}`); };
      ws.onmessage = () => { if (++got === 10) ws.close(); };
      ws.onclose = ws.onerror = () => done();
    });
  }
}

// One subscriber that never reads: before #82 this grew the server without bound.
const slow = await fetch(`${base}/hub`);

const samples: (Mem & { t: number })[] = [];
const sampler = (async () => {
  while (!stop) {
    samples.push({ t: samples.length * 5, ...(await mem()) });
    await sleep(5000);
  }
})();
const churn = [sseChurn(), sseChurn(), wsChurn(), wsChurn()];
const load = await autocannon({ url: `${base}/json`, connections: 50, duration: SECONDS });
stop = true;
await Promise.all([sampler, ...churn]);
const last = await mem();

// close() while traffic is still flowing
const tail = autocannon({ url: `${base}/json`, connections: 20, duration: 30 });
await sleep(1000);
child.kill('SIGTERM');
const code = await Promise.race([exited, sleep(20_000).then(() => 'timeout' as const)]);
tail.stop();
void slow.body?.cancel().catch(() => {});

const third = Math.max(1, Math.floor(samples.length / 3));
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const early = median(samples.slice(1, 1 + third).map((s) => s.heapUsed)); // skip the cold sample
const late = median(samples.slice(-third).map((s) => s.heapUsed));
const growth = late - early;
const mb = (n: number) => (n / 2 ** 20).toFixed(1);

console.table(samples.map((s) => ({ t: s.t, rssMB: mb(s.rss), heapMB: mb(s.heapUsed), handles: s.handles })));
console.log(
  `req/s ${load.requests.average}, p99 ${load.latency.p99} ms, errors ${load.errors}, non2xx ${load.non2xx}; ` +
    `heap ${mb(early)} -> ${mb(late)} MB; unhandled ${last.unhandled}; close under load: exit ${code}`,
);

const failures = [
  growth > 8 * 2 ** 20 && growth > early * 0.25 && `heap grew ${mb(growth)} MB`,
  last.unhandled > 0 && `${last.unhandled} unhandled rejection(s)`,
  load.non2xx > 0 && `${load.non2xx} non-2xx responses`,
  code !== 0 && `close() under load: exit ${code}`,
].filter(Boolean);
if (code === 'timeout') child.kill('SIGKILL');
if (failures.length) {
  console.error(`SOAK FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('SOAK OK');
