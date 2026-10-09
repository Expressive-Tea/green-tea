// Real Miniflare (workerd) integration test for edgeHandler: bundles test/edge/worker.ts
// for the Cloudflare Workers runtime and boots it in the actual workerd engine (via the
// `miniflare` npm package — no CF account/deploy needed), then round-trips HTTP + WS
// through the real graph.
//
// Run with: npm run test:edge
//
// NODEJS_COMPAT: workerd's `nodejs_compat` genuinely does NOT implement `node:http`/
// `node:https` (confirmed in isolation: `node:crypto`, `node:stream`, `node:net`, `node:tls`,
// `node:events`, `node:util`, `node:buffer` all load fine under the same flags/compat date;
// only `http`/`https` fail with "Uncaught Error: No such module 'node:http'" at worker LOAD
// time) — a real platform gap, not a bundler misconfiguration. The barrel used to statically
// VALUE-import `http`/`https` for the Node `listen()` path even though `edgeHandler` never
// touches them, which broke worker load with no shim. The fix (see src/http/server.ts,
// src/app/index.ts, and the other src/http/*.ts files) converts every `http`/`https` import
// to `import type` (zero runtime code) and lazy-`require()`s them only inside
// `createHttpServer`, which the edge path never calls. That means the real barrel now loads
// on workerd with no test-time stub — this run exercises it as-is.
import { strict as assert } from 'node:assert';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const BUNDLE = 'test/edge/_worker.mjs';

async function main() {
  // Bundle the worker for workerd: ESM, Node builtins left external + aliased to node:*
  // so workerd's nodejs_compat provides them (not esbuild). `http`/`https` are no longer
  // imported as VALUES by the barrel at module-eval time (see comment above) — they're now
  // `import type` (erased) plus a lazy `require()` reached only from `createHttpServer`,
  // which `edgeHandler` never calls. esbuild still needs a resolution for that bare
  // `require('http')`/`require('https')` text even though it's dead code on this path, so
  // they're marked external here (left unresolved, exactly like the `node:*` builtins) rather
  // than stubbed — no fake implementation is provided, and the real barrel is what's tested.
  await build({
    entryPoints: ['test/edge/worker.ts'],
    bundle: true,
    format: 'esm',
    outfile: BUNDLE,
    platform: 'browser', // workerd is not node; keep esbuild from injecting node shims
    target: 'esnext',
    // Leave Node builtins for workerd's nodejs_compat to resolve; http/https are external
    // too (unresolved, never called by edgeHandler) since workerd has no node:http/https.
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

  const mf = new Miniflare({
    modules: true,
    scriptPath: BUNDLE,
    compatibilityDate: '2024-11-01',
    compatibilityFlags: ['nodejs_compat'],
  });

  try {
    // HTTP
    const httpRes = await mf.dispatchFetch('http://localhost/rt/hello');
    assert.equal(httpRes.status, 200);
    assert.deepEqual(await httpRes.json(), { ok: true });

    // Body limits (#105): the same statuses as app.fetch, Deno and Bun. workerd may drop a
    // chunked upload's content-length, so the streamed case is enforced by the read count alone.
    const LIMIT = 1000; // the route's maxBodyBytes, see worker.ts
    const post = async (body: Uint8Array | string | ReadableStream<Uint8Array>): Promise<number> => {
      const res = await mf.dispatchFetch('http://localhost/rt/body', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body,
        duplex: 'half',
      } as Parameters<typeof mf.dispatchFetch>[1]);
      await res.arrayBuffer();
      return res.status;
    };
    const chunks = (count: number, size: number): ReadableStream<Uint8Array> => {
      let sent = 0;
      return new ReadableStream({
        pull(controller) {
          if (sent++ === count) controller.close();
          else controller.enqueue(new Uint8Array(size).fill(0x61));
        },
      });
    };
    assert.equal(await post(new Uint8Array(2 * LIMIT)), 413, 'declared content-length over the limit');
    assert.equal(await post(chunks(10, 300)), 413, 'streamed body over the limit');
    assert.equal(await post('x'.repeat(LIMIT)), 200, 'exactly the limit');
    assert.equal(await post('x'.repeat(LIMIT + 1)), 413, 'one byte over the limit');

    // WebSocket
    const wsRes = await mf.dispatchFetch('http://localhost/rt/echo', {
      headers: { Upgrade: 'websocket' },
    });
    assert.equal(wsRes.status, 101);
    const ws = wsRes.webSocket;
    assert.ok(ws, 'expected a client webSocket on the 101 response');
    ws.accept();
    const got = await new Promise<string>((resolve, reject) => {
      ws.addEventListener('message', (e: { data: unknown }) => {
        resolve(String(e.data));
        ws.close();
      });
      ws.addEventListener('error', () => reject(new Error('ws error')));
      ws.send('hi');
    });
    assert.equal(got, 'echo:hi');

    // #104: a malformed escape in a param segment closes 1008 instead of 1011, and HTTP still serves.
    const badRes = await mf.dispatchFetch('http://localhost/rt/room/%E0%A4%A', {
      headers: { Upgrade: 'websocket' },
    });
    const bad = badRes.webSocket;
    assert.ok(bad, 'expected a client webSocket on the 101 response');
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      bad.addEventListener('close', (e: { code: number; reason: string }) => resolve({ code: e.code, reason: e.reason })),
    );
    bad.accept();
    assert.deepEqual(await closed, { code: 1008, reason: 'invalid request path' });
    assert.equal((await mf.dispatchFetch('http://localhost/rt/hello')).status, 200);

    // #107: workerd delivers the whole message before user code sees it, so the size bound is
    // checked after receipt; the close codes match Node and Deno.
    const limitedEcho = async (frames: string[]) => exchange(mf, 'http://limited/rt/echo', frames);
    assert.deepEqual((await limitedEcho(['a'.repeat(1024)])).replies, [`echo:${'a'.repeat(1024)}`]);
    assert.deepEqual((await limitedEcho(['a'.repeat(1025)])).close, { code: 1009, reason: 'message too large' });
    assert.deepEqual((await exchange(mf, 'http://limited/rt/stall', ['1', '2', '3', '4', '5'])).close, {
      code: 1013,
      reason: 'inbound queue full',
    });
    assert.equal((await exchange(mf, 'http://localhost/rt/echo', ['a'.repeat(1_048_576)])).replies.length, 1);
    assert.equal((await exchange(mf, 'http://localhost/rt/echo', ['a'.repeat(1_048_577)])).close?.code, 1009);

    console.log('edge (workerd via miniflare): HTTP 200 + body limits 413/413/200/413 + WS echo:hi + ws limits — PASS');
  } finally {
    await mf.dispose();
  }
}

/** Opens a ws on `url`, sends `frames`, and resolves with the replies and the close (or none within `ms`). */
async function exchange(mf: Miniflare, url: string, frames: string[], ms = 1000) {
  const res = await mf.dispatchFetch(url, { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket;
  assert.ok(ws, `expected a client webSocket on the 101 response for ${url}`);
  const replies: string[] = [];
  const result = new Promise<{ replies: string[]; close?: { code: number; reason: string } }>((resolve) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve({ replies });
    }, ms);
    ws.addEventListener('message', (e: { data: unknown }) => replies.push(String(e.data)));
    ws.addEventListener('close', (e: { code: number; reason: string }) => {
      clearTimeout(timer);
      resolve({ replies, close: { code: e.code, reason: e.reason } });
    });
  });
  ws.accept();
  for (const frame of frames) ws.send(frame);
  return result;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
