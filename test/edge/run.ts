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

    console.log('edge (workerd via miniflare): HTTP 200 + WS echo:hi — PASS');
  } finally {
    await mf.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
