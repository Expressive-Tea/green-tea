// CARD-16 (#112) on real workerd via miniflare: T1 (edge), T12, T13, T16 and SSE. Reads raw bytes
// off a real socket with node:http — `dispatchFetch` would decode and hide a double encoding — and
// peels encodings by magic bytes, requiring at most one layer and the original bytes. Run twice:
// with the default compat flags (workerd detected through `navigator.userAgent`) and with
// `no_global_navigator` (no `navigator` at all), so neither signal alone carries the result.
//
// Run with: tsx test/edge/compression.ts   (chained from `npm run test:edge`)
import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { JSON_BODY, HTML_BODY, SSE_EVENTS, SSE_GAP_MS } from '../fixtures/compression-app';

const BUNDLE = 'test/edge/_compression-worker.mjs';

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Buffer;
}

function get(url: URL, path: string, host: string, ae?: string): Promise<Raw> {
  return new Promise((resolve, reject) => {
    http
      .get(new URL(path, url), { headers: { host, ...(ae ? { 'accept-encoding': ae } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

/** Decodes by magic bytes, not by header, so a second layer is counted even if the header lies. */
function peel(bytes: Buffer): { layers: string[]; text: string } {
  const layers: string[] = [];
  let b = bytes;

  for (let k = 0; k < 4; k++) {
    if (b[0] === 0x1f && b[1] === 0x8b) {
      b = zlib.gunzipSync(b);
      layers.push('gzip');
      continue;
    }

    const first = b.toString('utf8', 0, 1);
    if (b.length === 0 || first === '{' || first === '<') break;

    try {
      b = zlib.brotliDecompressSync(b);
      layers.push('br');
    } catch {
      layers.push('??');
      break;
    }
  }

  return { layers, text: b.toString('utf8') };
}

function sseLags(url: URL, host: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    http
      .get(new URL('/c/sse', url), { headers: { host, 'accept-encoding': 'gzip, br', accept: 'text/event-stream' } }, (res) => {
        assert.equal(res.headers['content-encoding'], undefined, 'edge SSE: encoded');
        const out: number[] = [];
        let buf = '';
        res.on('data', (d: Buffer) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const m = buf.slice(0, i).match(/data: (\{.*\})/);
            buf = buf.slice(i + 2);
            if (m) out.push(Date.now() - JSON.parse(m[1]).t);
          }
        });
        res.on('end', () => resolve(out));
      })
      .on('error', reject);
  });
}

async function run(flags: string[]): Promise<void> {
  const mf = new Miniflare({
    modules: true,
    scriptPath: BUNDLE,
    compatibilityDate: '2024-11-01',
    compatibilityFlags: flags,
    host: '127.0.0.1',
    port: 0,
  });
  const url = await mf.ready;

  try {
    for (const host of ['handler', 'bare']) {
      for (const [path, original] of [
        ['/c/json', JSON_BODY],
        ['/c/html', HTML_BODY],
      ] as const) {
        for (const ae of ['gzip, br', 'gzip', 'br', 'br;q=0, gzip', 'identity', undefined]) {
          const label = `[${flags.join(',')}] ${host} ${path} ${ae ?? '(none)'}`;
          const r = await get(url, path, host, ae);
          const { layers, text } = peel(r.bytes);
          assert.equal(r.status, 200, `${label}: status ${r.status}`);
          assert.ok(layers.length <= 1, `${label}: ${layers.join('+')} — doubly encoded`);
          assert.equal(text, original, `${label}: body mismatch`);
          assert.equal(r.headers['content-encoding'], layers[0], `${label}: header does not match the payload`);
          assert.match(String(r.headers.vary), /accept-encoding/i, `${label}: no Vary`);
          if (!ae || ae === 'identity') assert.equal(layers.length, 0, `${label}: identity client got an encoding`);
        }
      }

      const lags = await sseLags(url, host);
      assert.equal(lags.length, SSE_EVENTS, `${host}: SSE events`);
      for (const lag of lags) assert.ok(lag < SSE_GAP_MS / 2, `${host}: SSE lag ${lag} ms`);
    }
  } finally {
    await mf.dispose();
  }
}

async function main() {
  await build({
    entryPoints: ['test/edge/compression-worker.ts'],
    bundle: true,
    format: 'esm',
    outfile: BUNDLE,
    platform: 'browser',
    target: 'esnext',
    external: ['node:*', 'http', 'https'],
    alias: {
      crypto: 'node:crypto',
      stream: 'node:stream',
      zlib: 'node:zlib',
      buffer: 'node:buffer',
      events: 'node:events',
      net: 'node:net',
      tls: 'node:tls',
      util: 'node:util',
    },
  });

  await run(['nodejs_compat']);
  await run(['nodejs_compat', 'no_global_navigator']);
  console.log(
    'edge (workerd): compression — edgeHandler and bare app.fetch, with and without navigator: identity from core, ≤ 1 layer on the wire, Vary set, SSE on time — PASS',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
