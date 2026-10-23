// CARD-16 (#112): the server-runtime checks shared by test/deno/compression.test.ts and
// test/bun/compression.test.ts, run against `compressionApp({ compression: true, etag: true })`
// served by the runtime's own server. Each check throws on failure. Reads go through `node:http`,
// which decodes nothing, so a double encoding cannot hide.
import http from 'node:http';
import zlib from 'node:zlib';
import { JSON_BODY, HTML_BODY, SSE_EVENTS, SSE_GAP_MS } from './compression-app';

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Uint8Array;
}

function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Uint8Array[] = [];
      res.on('data', (c: Uint8Array) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const decode = (bytes: Uint8Array, ce: unknown): string =>
  new TextDecoder().decode(
    ce === 'br' ? zlib.brotliDecompressSync(bytes) : ce === 'gzip' ? zlib.gunzipSync(bytes) : bytes,
  );

function check(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

const hasVary = (r: Raw) => /accept-encoding/i.test(String(r.headers.vary ?? ''));

/** T1–T6 and T12: negotiation, one layer, original bytes. */
async function negotiation(port: number): Promise<void> {
  const cases: [string, string | undefined, string | undefined, string][] = [
    ['/c/json', 'gzip, br', 'br', JSON_BODY], // T1
    ['/c/json', 'br;q=0, gzip', 'gzip', JSON_BODY], // T2
    ['/c/json', 'identity', undefined, JSON_BODY], // T3
    ['/c/json', undefined, undefined, JSON_BODY], // T3
    ['/c/json', '*;q=0', undefined, JSON_BODY], // T4
    ['/c/json', '*', 'br', JSON_BODY], // T5
    ['/c/html', 'gzip', 'gzip', HTML_BODY], // T12
    ['/c/html', 'br', 'br', HTML_BODY],
  ];

  for (const [path, ae, ce, original] of cases) {
    const r = await get(port, path, ae === undefined ? {} : { 'accept-encoding': ae });
    const label = `${path} ${ae ?? '(none)'}`;
    check(r.headers['content-encoding'] === ce, `${label}: content-encoding ${String(r.headers['content-encoding'])}, expected ${ce}`);
    check(hasVary(r), `${label}: no Vary`);
    check(decode(r.bytes, ce) === original, `${label}: body does not decode to the original bytes`);
  }
}

/** T7, T8, T11, T15: skips, and the 304 shape. */
async function skips(port: number): Promise<void> {
  for (const [path, vary] of [
    ['/c/small', true],
    ['/c/png', false],
    ['/c/notype', false],
    ['/c/range', false],
    ['/c/notransform', false],
  ] as const) {
    const r = await get(port, path, { 'accept-encoding': 'gzip, br' });
    check(r.headers['content-encoding'] === undefined, `${path}: encoded`);
    check(hasVary(r) === vary, `${path}: Vary ${String(r.headers.vary)}`);
  }

  const head = await get(port, '/c/json', { 'accept-encoding': 'gzip' }, 'HEAD');
  check(head.headers['content-encoding'] === undefined && hasVary(head), 'HEAD: encoded or no Vary');
  const nm = await get(port, '/c/304', { 'accept-encoding': 'gzip' });
  check(nm.status === 304 && hasVary(nm) && nm.headers['content-type'] === undefined, 'T15: 304 shape');
}

/** T10: the ETag does not change with the coding, and its 304 carries Vary. */
async function etag(port: number): Promise<void> {
  const identity = await get(port, '/c/plainjson', { 'accept-encoding': 'identity' });
  const gz = await get(port, '/c/plainjson', { 'accept-encoding': 'gzip' });
  check(gz.headers['content-encoding'] === 'gzip', 'T10: not gzip');
  check(gz.headers.etag !== undefined && gz.headers.etag === identity.headers.etag, 'T10: ETag differs by coding');
  const nm = await get(port, '/c/plainjson', { 'accept-encoding': 'gzip', 'if-none-match': String(gz.headers.etag) });
  check(nm.status === 304 && hasVary(nm) && nm.bytes.length === 0, 'T10: 304 without Vary or with a body');
}

/** T14: ndjson decodes to the same lines. */
async function ndjson(port: number): Promise<void> {
  for (const ce of ['gzip', 'br']) {
    const r = await get(port, '/c/ndjson', { 'accept-encoding': ce });
    check(r.headers['content-encoding'] === ce, `T14 ${ce}: not encoded`);
    check(decode(r.bytes, ce) === '{"n":0}\n{"n":1}\n{"n":2}\n', `T14 ${ce}: lines differ`);
  }
}

/** T9: each SSE event decodes before the next one is produced. Returns the per-event lags. */
async function sse(port: number): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};

  for (const ce of ['gzip', 'br']) {
    out[ce] = await new Promise<number[]>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/c/sse', headers: { 'accept-encoding': ce, accept: 'text/event-stream' } }, (res) => {
          if (res.headers['content-encoding'] !== ce) reject(new Error(`T9 ${ce}: not encoded`));
          const dec = ce === 'br' ? zlib.createBrotliDecompress() : zlib.createGunzip();
          const lags: number[] = [];
          let buf = '';
          dec.on('data', (d: Uint8Array) => {
            buf += new TextDecoder().decode(d);
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const m = buf.slice(0, i).match(/data: (\{.*\})/);
              buf = buf.slice(i + 2);
              if (m) lags.push(Date.now() - JSON.parse(m[1]).t);
            }
          });
          res.pipe(dec);
          dec.on('end', () => resolve(lags));
          dec.on('error', reject);
        })
        .on('error', reject);
    });
    check(out[ce].length === SSE_EVENTS, `T9 ${ce}: ${out[ce].length} events`);
    for (const lag of out[ce]) check(lag < SSE_GAP_MS / 2, `T9 ${ce}: event lag ${lag} ms`);
  }

  return out;
}

export const checks = { negotiation, skips, etag, ndjson, sse };

/**
 * How many 1 ms timer ticks fire while `zlib.gzip` (the async API core uses) compresses 16 MB of
 * random bytes — incompressible, so the work takes a few hundred ms on any machine (repetitive
 * input finished in 4 ms on a CI runner and proved nothing). When the runtime offloads zlib to a
 * worker thread the loop keeps ticking, roughly one tick per ms; when it runs it on the main thread
 * (Deno 2.9.7, SPIKE-COMPRESSION-B §7) almost none fire. The runtime docs state which one each
 * runtime does, and the suites pin it with this.
 */
export async function ticksDuringGzip(): Promise<{ ms: number; ticks: number }> {
  const bytes = new Uint8Array(16 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const started = performance.now();
  await new Promise<void>((resolve, reject) => zlib.gzip(bytes, (err) => (err ? reject(err) : resolve())));
  const ms = performance.now() - started;
  clearInterval(timer);
  return { ms, ticks };
}

/** Compression off: the runtime's server sends identity even to a gzip client (it does not compress by itself). */
export async function serverDoesNotCompress(port: number): Promise<void> {
  const r = await get(port, '/c/html', { 'accept-encoding': 'gzip, br' });
  check(r.headers['content-encoding'] === undefined, `the server encoded by itself: ${String(r.headers['content-encoding'])}`);
  check(decode(r.bytes, undefined) === HTML_BODY, 'body changed');
}
