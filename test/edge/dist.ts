// #93: the published `dist/` ESM build must load on workerd. test/edge/run.ts bundles `src/`, so it
// never saw tsup's `createRequire` banner, which ran at module scope and threw there because
// `import.meta.url` is not a file URL. `npm run test:edge` builds first.
//
// Run with: npm run test:edge
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const BUNDLE = 'test/edge/_dist-worker.mjs';

async function main() {
  if (!existsSync('dist/edge.mjs')) throw new Error('dist/edge.mjs is missing: run `npm run build` first');
  // Same bundling as run.ts, which is what wrangler does with an installed package.
  await build({
    entryPoints: ['test/edge/dist-worker.ts'],
    bundle: true,
    format: 'esm',
    outfile: BUNDLE,
    platform: 'browser',
    target: 'esnext',
    external: ['node:*', 'http', 'https'],
    alias: { stream: 'node:stream', events: 'node:events', zlib: 'node:zlib', crypto: 'node:crypto' },
  });

  const mf = new Miniflare({
    modules: true,
    scriptPath: BUNDLE,
    compatibilityDate: '2024-11-01',
    compatibilityFlags: ['nodejs_compat'],
  });
  try {
    const res = await mf.dispatchFetch('http://localhost/rt/hello');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    console.log('edge dist: OK (the npm ESM build loads and serves on workerd)');
  } finally {
    await mf.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
