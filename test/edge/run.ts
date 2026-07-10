// Real Miniflare (workerd) integration test for edgeHandler: bundles test/edge/worker.ts
// for the Cloudflare Workers runtime and boots it in the actual workerd engine (via the
// `miniflare` npm package — no CF account/deploy needed), then round-trips HTTP + WS
// through the real graph.
//
// Run with: npm run test:edge
//
// NODEJS_COMPAT FRICTION (found by running this against real Miniflare — see
// project-docs/.superpowers/sdd/task-2-report.md for full detail): the barrel
// (`src/index.ts` -> `createApp` -> `src/app/index.ts` -> `src/http/server.ts`) statically
// imports Node's `http`/`https` as VALUES (for the Node `listen()`/`http.createServer` path),
// even though `edgeHandler`'s request path never touches them. workerd's `nodejs_compat`
// genuinely does NOT implement `node:http`/`node:https` (confirmed in isolation: `node:crypto`,
// `node:stream`, `node:net`, `node:tls`, `node:events`, `node:util`, `node:buffer` all load
// fine under the same flags/compat date; only `http`/`https` fail with
// "Uncaught Error: No such module 'node:http'" at worker LOAD time, regardless of
// compatibilityDate 2023-05-01..2024-11-01 or alias tweaks) — this is a real platform gap,
// not a bundler misconfiguration.
//
// To let this test actually exercise edgeHandler's real HTTP+WS behavior on workerd (rather
// than stopping at "the barrel doesn't load"), the two Node-only server builtins are stubbed
// at BUNDLE TIME (esbuild plugin below) with inert objects whose `createServer` throws if
// ever called. This only satisfies static module resolution for code edgeHandler never
// executes; it does not change src/edge.ts or core, and does not touch the WS assertion.
// It is a TEST-ONLY workaround, not proof that `node:http`/`node:https` work under workerd —
// they don't. See the report for the recommended follow-up (lazy-defer those imports behind
// `listen()` in src/app/index.ts / src/http/server.ts so the barrel is edge-safe without a
// bundle-time shim).
import { strict as assert } from 'node:assert';
import { build, type Plugin } from 'esbuild';
import { Miniflare } from 'miniflare';

const BUNDLE = 'test/edge/_worker.mjs';

// Stubs Node's `http`/`https` (unsupported by workerd's nodejs_compat) with inert modules.
// edgeHandler's request path never calls these; they exist in the barrel only for the Node
// `listen()` path. Any call would throw clearly rather than resolve to a wrong behavior.
const stubUnsupportedNodeServerModules: Plugin = {
  name: 'stub-unsupported-node-server-modules',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^(http|https)$/ }, (args) => ({
      path: args.path,
      namespace: 'edge-test-stub',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'edge-test-stub' }, (args) => ({
      contents: `
        function createServer() {
          throw new Error(${JSON.stringify(args.path)} + '.createServer is not available in the edge runtime (no nodejs_compat support; edgeHandler never calls it)');
        }
        export default { createServer };
        export { createServer };
      `,
      loader: 'js',
    }));
  },
};

async function main() {
  // Bundle the worker for workerd: ESM, Node builtins left external + aliased to node:*
  // so workerd's nodejs_compat provides them (not esbuild) — except http/https, which
  // workerd genuinely doesn't implement (see comment above); those are stubbed instead.
  await build({
    entryPoints: ['test/edge/worker.ts'],
    bundle: true,
    format: 'esm',
    outfile: BUNDLE,
    platform: 'browser', // workerd is not node; keep esbuild from injecting node shims
    target: 'esnext',
    // Leave Node builtins for workerd's nodejs_compat to resolve:
    external: ['node:*'],
    plugins: [stubUnsupportedNodeServerModules],
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
