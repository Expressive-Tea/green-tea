// CARD-14 (#113) under the real Bun runtime: Set-Cookie arrays leave `Bun.serve` as separate
// lines, and @cookie reads the request header. Run with: npm run test:bun
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';
import { CookieModule, C1, C2 } from '../fixtures/cookie-app.ts';

test('T7/T8/T11 on Bun.serve: two Set-Cookie lines, other arrays joined, @cookie decoded', async () => {
  const server = await serveBun(createApp({ modules: [CookieModule] }), { hostname: '127.0.0.1', port: 0 });

  try {
    const base = `http://127.0.0.1:${server.port}`;
    const two = await fetch(`${base}/c/two`);
    await two.arrayBuffer();
    expect(two.headers.getSetCookie()).toEqual([C1, C2]);
    expect(two.headers.get('x-custom')).toBe('a, b');

    const error = await fetch(`${base}/c/error`);
    await error.arrayBuffer();
    expect(error.status).toBe(401);
    expect(error.headers.getSetCookie()).toEqual([C1, C2]);

    const one = await fetch(`${base}/c/one`, { headers: { cookie: 'a=1; a=2; b=%41' } });
    expect(await one.json()).toEqual({ a: '1', b: 'A' });
  } finally {
    await server.close({ timeoutMs: 1000 });
  }
});
