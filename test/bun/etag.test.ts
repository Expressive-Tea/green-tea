// CARD-15 (#114) under the real Bun runtime: static 304 without reading the file (T1), and a
// handler ETag round-trip under `etag: true` (T5). Run with: npm run test:bun
import 'reflect-metadata';
import fs from 'node:fs';
import { test, expect, spyOn } from 'bun:test';
import { createApp } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';
import { EtagModule, STATIC_DIR } from '../fixtures/etag-app.ts';

test('T1/T5 on Bun.serve: static and handler 304s, readFile once', async () => {
  const readFile = spyOn(fs.promises, 'readFile');
  const server = await serveBun(createApp({ modules: [EtagModule], etag: true, static: STATIC_DIR }), {
    hostname: '127.0.0.1',
    port: 0,
  });
  const base = `http://127.0.0.1:${server.port}`;

  try {
    const s1 = await fetch(`${base}/asset.txt`);
    expect(await s1.text()).toBe('served');
    const etag = s1.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"\d+-[0-9a-z]+"$/);
    expect(s1.headers.get('cache-control')).toBe('no-cache');
    const s2 = await fetch(`${base}/asset.txt`, { headers: { 'if-none-match': etag } });
    expect([s2.status, await s2.text(), s2.headers.get('etag'), s2.headers.get('content-type')]).toEqual([304, '', etag, null]);
    expect(readFile).toHaveBeenCalledTimes(1);

    const h1 = await fetch(`${base}/h/json`);
    await h1.text();
    const tag = h1.headers.get('etag')!;
    const h2 = await fetch(`${base}/h/json`, { headers: { 'if-none-match': tag } });
    expect([h2.status, await h2.text(), h2.headers.get('etag')]).toEqual([304, '', tag]);
  } finally {
    readFile.mockRestore();
    await server.close({ timeoutMs: 1000 });
  }
});
