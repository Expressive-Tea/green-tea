// #105 on the real Bun runtime: the request-body limit is enforced while the body is read, both on
// `app.fetch` directly and through `serveBun`. The counting stream is what proves the read stopped —
// a 413 looks the same whether the body was buffered first or not.
//
// Run with: npm run test:bun  (or: bun test test/bun/)
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp, Route, Post, Module, body } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';
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

test('T1 app.fetch: a declared content-length over the limit is refused unread', async () => {
  const app = createApp({ modules: [M] });
  const source = countingStream(10, 300_000);

  const res = await app.fetch(post('http://x/echo', source.stream, { 'content-length': '2000000' }));

  expect(res.status).toBe(413);
  expect(source.pulled).toBe(0);
  expect(source.cancelled).toBe(true);
  await app.close();
});

test('T3 app.fetch: a streamed body stops at the chunk that crosses the limit', async () => {
  const app = createApp({ modules: [M] });
  const source = countingStream(10, 300_000);

  const res = await app.fetch(post('http://x/echo', source.stream));

  expect(res.status).toBe(413);
  expect(source.pulled).toBeLessThanOrEqual(5);
  expect(source.cancelled).toBe(true);
  await app.close();
});

test('T5 app.fetch: exactly the limit is accepted, one byte over is refused', async () => {
  const app = createApp({ modules: [M] });

  const at = await app.fetch(post('http://x/echo', 'x'.repeat(LIMIT), { 'content-type': 'text/plain' }));
  const over = await app.fetch(post('http://x/echo', 'x'.repeat(LIMIT + 1), { 'content-type': 'text/plain' }));

  expect(at.status).toBe(200);
  expect(await at.json()).toEqual({ length: LIMIT });
  expect(over.status).toBe(413);
  await app.close();
});

test('T11 serveBun: the same statuses over a real socket', async () => {
  const server = await serveBun(createApp({ modules: [M] }), { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  // A fresh connection per request. Bun's *client* reuses a kept-alive socket after a response that
  // arrived before the server read the request body, and its next request on that socket comes back
  // 400 or 431. Node's fetch against the same Bun server does not (Bun 1.3.14), so it is the client
  // that misbehaves, not `serveBun`.
  const send = (body: BodyInit, headers?: Record<string, string>) =>
    fetch(post(`${base}/small`, body, headers), { keepalive: false } as RequestInit);

  try {
    expect((await send(new Uint8Array(2 * SMALL))).status).toBe(413);
    expect((await send(countingStream(10, 300).stream)).status).toBe(413);
    expect((await send('x'.repeat(SMALL), { 'content-type': 'text/plain' })).status).toBe(200);
    expect((await send('x'.repeat(SMALL + 1), { 'content-type': 'text/plain' })).status).toBe(413);
  } finally {
    await server.close({ timeoutMs: 1000 });
  }
});
