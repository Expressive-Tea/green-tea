// CARD-16 (#112) under the real Bun runtime: `Bun.serve` does not compress by itself, so every
// encoding here is core's, through `node:zlib`. Run with: npm run test:bun
import 'reflect-metadata';
import { test } from 'bun:test';
import { serveBun } from '../../src/bun.ts';
import { compressionApp } from '../fixtures/compression-app.ts';
import { checks, serverDoesNotCompress, ticksDuringGzip } from '../fixtures/compression-checks.ts';

for (const [name, run] of Object.entries(checks)) {
  test(`compression on Bun.serve: ${name}`, async () => {
    const server = await serveBun(compressionApp({ compression: true, etag: true }), { hostname: '127.0.0.1', port: 0 });

    try {
      await run(server.port);
    } finally {
      await server.close({ timeoutMs: 1000 });
    }
  });
}

// The documented Bun facts (CARD-16; `guides/runtimes.md`).
test('documented: Bun.serve does not compress by itself (core compression off → identity)', async () => {
  const server = await serveBun(compressionApp(), { hostname: '127.0.0.1', port: 0 });

  try {
    await serverDoesNotCompress(server.port);
  } finally {
    await server.close({ timeoutMs: 1000 });
  }
});

test("documented: node:zlib's async gzip is off the main thread on Bun", async () => {
  const { ms, ticks } = await ticksDuringGzip();
  if (ms < 50) throw new Error(`gzip took ${Math.round(ms)} ms — too fast to tell; enlarge the input`);
  if (ticks < ms / 4) throw new Error(`only ${ticks} ticks in ${Math.round(ms)} ms: Bun blocked the loop — update the docs`);
});
