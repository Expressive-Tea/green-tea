// CARD-16 (#112) under the real Deno runtime, importing `src/` the way JSR serves it — so `node:zlib`
// is reached through `nodeRequire`'s `process.getBuiltinModule` path. Deno runs zlib's async API on
// the main thread (documented limitation); these checks cover correctness, not throughput.
// Run with: npm run test:deno
import 'npm:reflect-metadata';
import { serveDeno } from '../../src/deno.ts';
import { compressionApp } from '../fixtures/compression-app.ts';
import { checks, serverDoesNotCompress, ticksDuringGzip } from '../fixtures/compression-checks.ts';

for (const [name, run] of Object.entries(checks)) {
  Deno.test(`compression on Deno.serve: ${name}`, async () => {
    const server = await serveDeno(compressionApp({ compression: true, etag: true }), {
      hostname: '127.0.0.1',
      port: 0,
      onListen: () => {},
    });

    try {
      await run((server as unknown as { addr: { port: number } }).addr.port);
    } finally {
      await server.close({ timeoutMs: 1000 });
    }
  });
}

// The documented Deno facts (CARD-16; `guides/runtimes.md`). If one of these starts failing, Deno
// changed and the docs have to change with it — not the assertion.
Deno.test('documented: Deno.serve does not compress by itself (core compression off → identity)', async () => {
  const server = await serveDeno(compressionApp(), { hostname: '127.0.0.1', port: 0, onListen: () => {} });

  try {
    await serverDoesNotCompress((server as unknown as { addr: { port: number } }).addr.port);
  } finally {
    await server.close({ timeoutMs: 1000 });
  }
});

Deno.test("documented: node:zlib's async gzip runs on Deno's main thread", async () => {
  const { ms, ticks } = await ticksDuringGzip();
  if (ms < 50) throw new Error(`gzip took ${Math.round(ms)} ms — too fast to tell; enlarge the input`);
  if (ticks > Math.max(5, ms / 10))
    throw new Error(`timers kept firing (${ticks} ticks in ${Math.round(ms)} ms): Deno now offloads zlib — update the docs`);
});
