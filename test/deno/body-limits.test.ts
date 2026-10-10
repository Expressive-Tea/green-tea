// #105 on the real Deno runtime: the request-body limit is enforced while the body is read, both on
// `app.fetch` directly and through `serveDeno`. The counting stream is what proves the read stopped —
// a 413 looks the same whether the body was buffered first or not.
//
// Run with: npm run test:deno
import 'reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { createApp, Route, Post, Module, body } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';
import { countingStream } from '../helpers/counting-stream.ts';

const LIMIT = 1_000_000; // the server default
const SMALL = 1000;

@Route('/')
class Ctl {
  @Post('/echo') echo(@body() b: unknown) {
    return { length: String(b).length };
  }
  // Small for the socket tests, so every refused body fits in the socket buffer. A client still
  // writing a large body when the 413 lands can see a reset instead — the transport racing the
  // answer, not a different answer.
  @Post('/small', { maxBodyBytes: SMALL }) small(@body() b: unknown) {
    return { length: String(b).length };
  }
}
@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

const post = (url: string, body: BodyInit, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

Deno.test('T1 app.fetch: a declared content-length over the limit is refused unread', async () => {
  const app = createApp({ modules: [M] });
  const source = countingStream(10, 300_000);

  const res = await app.fetch(post('http://x/echo', source.stream, { 'content-length': '2000000' }));

  assertEquals(res.status, 413);
  assertEquals(source.pulled, 0);
  assertEquals(source.cancelled, true);
  await app.close();
});

Deno.test('T3 app.fetch: a streamed body stops at the chunk that crosses the limit', async () => {
  const app = createApp({ modules: [M] });
  const source = countingStream(10, 300_000);

  const res = await app.fetch(post('http://x/echo', source.stream));

  assertEquals(res.status, 413);
  if (source.pulled > 5) throw new Error(`pulled ${source.pulled} chunks — the read did not stop at the limit`);
  assertEquals(source.cancelled, true);
  await app.close();
});

Deno.test('T5 app.fetch: exactly the limit is accepted, one byte over is refused', async () => {
  const app = createApp({ modules: [M] });

  const at = await app.fetch(post('http://x/echo', 'x'.repeat(LIMIT), { 'content-type': 'text/plain' }));
  const over = await app.fetch(post('http://x/echo', 'x'.repeat(LIMIT + 1), { 'content-type': 'text/plain' }));

  assertEquals(at.status, 200);
  assertEquals(await at.json(), { length: LIMIT });
  assertEquals(over.status, 413);
  await over.body?.cancel();
  await app.close();
});

Deno.test('T11 serveDeno: the same statuses over a real socket', async () => {
  const server = await serveDeno(createApp({ modules: [M] }), { port: 0, onListen: () => {} });
  const base = `http://127.0.0.1:${(server as unknown as { addr: { port: number } }).addr.port}`;

  try {
    const send = (body: BodyInit, headers?: Record<string, string>) => fetch(post(`${base}/small`, body, headers));

    const declared = await send(new Uint8Array(2 * SMALL));
    assertEquals(declared.status, 413);
    await declared.body?.cancel();

    const streamed = await send(countingStream(10, 300).stream);
    assertEquals(streamed.status, 413);
    await streamed.body?.cancel();

    const at = await send('x'.repeat(SMALL), { 'content-type': 'text/plain' });
    assertEquals(at.status, 200);
    await at.body?.cancel();

    const over = await send('x'.repeat(SMALL + 1), { 'content-type': 'text/plain' });
    assertEquals(over.status, 413);
    await over.body?.cancel();
  } finally {
    await server.close({ timeoutMs: 1000 });
  }
});
