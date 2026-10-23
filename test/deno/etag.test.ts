// CARD-15 (#114) under the real Deno runtime: static 304 without reading the file (T1), and a
// handler ETag round-trip under `etag: true` (T5). Run with: npm run test:deno
import 'npm:reflect-metadata';
import fs from 'node:fs';
import { assertEquals, assertMatch } from 'jsr:@std/assert';
import { createApp } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';
import { EtagModule, STATIC_DIR } from '../fixtures/etag-app.ts';

Deno.test('T1/T5 on Deno.serve: static and handler 304s, readFile once', async () => {
  const original = fs.promises.readFile;
  let reads = 0;
  // deno-lint-ignore no-explicit-any
  (fs.promises as any).readFile = (...args: unknown[]) => {
    // Deno's own readFile re-enters this function with a file descriptor (FileHandle.readFile), so
    // only calls naming a path are reads by core.
    if (typeof args[0] === 'string') reads++;
    // deno-lint-ignore no-explicit-any
    return (original as any).apply(fs.promises, args);
  };

  const app = createApp({ modules: [EtagModule], etag: true, static: STATIC_DIR });
  const server = await serveDeno(app, { hostname: '127.0.0.1', port: 0, onListen: () => {} });
  const base = `http://127.0.0.1:${(server as unknown as { addr: { port: number } }).addr.port}`;

  try {
    const s1 = await fetch(`${base}/asset.txt`);
    assertEquals(await s1.text(), 'served');
    const etag = s1.headers.get('etag')!;
    assertMatch(etag, /^W\/"\d+-[0-9a-z]+"$/);
    assertEquals(s1.headers.get('cache-control'), 'no-cache');
    const s2 = await fetch(`${base}/asset.txt`, { headers: { 'if-none-match': etag } });
    assertEquals([s2.status, await s2.text(), s2.headers.get('etag'), s2.headers.get('content-type')], [304, '', etag, null]);
    assertEquals(reads, 1);

    const h1 = await fetch(`${base}/h/json`);
    await h1.text();
    const tag = h1.headers.get('etag')!;
    const h2 = await fetch(`${base}/h/json`, { headers: { 'if-none-match': tag } });
    assertEquals([h2.status, await h2.text(), h2.headers.get('etag')], [304, '', tag]);
  } finally {
    (fs.promises as { readFile: unknown }).readFile = original;
    await server.close({ timeoutMs: 1000 });
  }
});
