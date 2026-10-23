// CARD-14 (#113) under the real Deno runtime: Set-Cookie arrays leave `Deno.serve` as separate
// lines, and @cookie reads the request header. Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { createApp } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';
import { CookieModule, C1, C2 } from '../fixtures/cookie-app.ts';

Deno.test('T7/T8/T11 on Deno.serve: two Set-Cookie lines, other arrays joined, @cookie decoded', async () => {
  const server = await serveDeno(createApp({ modules: [CookieModule] }), { hostname: '127.0.0.1', port: 0, onListen: () => {} });
  const port = (server as unknown as { addr: { port: number } }).addr.port;

  try {
    const two = await fetch(`http://127.0.0.1:${port}/c/two`);
    await two.body?.cancel();
    assertEquals(two.headers.getSetCookie(), [C1, C2]);
    assertEquals(two.headers.get('x-custom'), 'a, b');

    const error = await fetch(`http://127.0.0.1:${port}/c/error`);
    await error.body?.cancel();
    assertEquals(error.status, 401);
    assertEquals(error.headers.getSetCookie(), [C1, C2]);

    const one = await fetch(`http://127.0.0.1:${port}/c/one`, { headers: { cookie: 'a=1; a=2; b=%41' } });
    assertEquals(await one.json(), { a: '1', b: 'A' });
  } finally {
    await server.close({ timeoutMs: 1000 });
  }
});
