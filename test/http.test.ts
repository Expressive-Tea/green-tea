import { describe, expect, it, test } from 'vitest';
import { matchRoute, parseQuery, createHttpServer } from '../src/http';

const handler = async () => ({ status: 200, headers: {}, body: 'ok' });

test('matches a static + :param route and extracts params', () => {
  const routes = [{ method: 'GET', pattern: '/api/users/:id', transport: 'buffer' as const, handler }];
  const m = matchRoute(routes, 'GET', '/api/users/42');
  expect(m?.params).toEqual({ id: '42' });
});

test('returns undefined when nothing matches', () => {
  const routes = [{ method: 'GET', pattern: '/api/users/:id', transport: 'buffer' as const, handler }];
  expect(matchRoute(routes, 'GET', '/api/orders/1')).toBeUndefined();
  expect(matchRoute(routes, 'POST', '/api/users/1')).toBeUndefined();
});

test('parseQuery extracts query params from a url', () => {
  expect(parseQuery('/api/users/9?q=hi&date=2026')).toEqual({ q: 'hi', date: '2026' });
  expect(parseQuery('/api/users/9')).toEqual({});
});

test('server parses json body and rejects malformed json with 400', async () => {
  const server = createHttpServer([{
    method: 'POST', pattern: '/echo', transport: 'buffer',
    handler: async (req) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ got: req.body, q: req.query }) }),
  }]);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;

  const ok = await fetch(`http://127.0.0.1:${port}/echo?x=1`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }),
  });
  expect(await ok.json()).toEqual({ got: { a: 1 }, q: { x: '1' } });

  const bad = await fetch(`http://127.0.0.1:${port}/echo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  expect(bad.status).toBe(400);

  server.close();
});

const getServerUrl = (server: import('http').Server) => {
  const addr = server.address();
  if (addr && typeof addr === 'object') return `http://127.0.0.1:${addr.port}`;
  throw new Error('no address');
};

describe('http streaming', () => {
  it('streams SSE events from an async-iterable handler and runs finally on disconnect', async () => {
    let cleanedUp = false;
    async function* feed() {
      try { yield { n: 1 }; yield { n: 2 }; await new Promise((r) => setTimeout(r, 50)); yield { n: 3 }; }
      finally { cleanedUp = true; }
    }
    const server = createHttpServer([
      { method: 'GET', pattern: '/feed', transport: 'sse', handler: async () => ({ stream: feed() }) },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    const res = await fetch(`${getServerUrl(server)}/feed`, { headers: { accept: 'text/event-stream' } });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!buf.includes('data: {"n":2}')) buf += dec.decode((await reader.read()).value);
    expect(buf).toContain('data: {"n":1}\n\n');
    await reader.cancel();             // client disconnect
    await new Promise((r) => setTimeout(r, 60));
    expect(cleanedUp).toBe(true);
    server.close();
  });

  it('frames a mid-stream error and closes', async () => {
    async function* boom() { yield { ok: true }; throw new Error('kaboom'); }
    const server = createHttpServer([
      { method: 'GET', pattern: '/boom', transport: 'sse', handler: async () => ({ stream: boom() }) },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    const res = await fetch(`${getServerUrl(server)}/boom`, { headers: { accept: 'text/event-stream' } });
    const text = await res.text();
    expect(text).toContain('data: {"ok":true}\n\n');
    expect(text).toContain('event: error');
    expect(text).toContain('kaboom');
    server.close();
  });

  it('routes by method (non-GET no longer falls through)', async () => {
    const server = createHttpServer([
      { method: 'POST', pattern: '/make', transport: 'buffer',
        handler: async () => ({ status: 201, headers: { 'content-type': 'application/json' }, body: '{"made":true}' }) },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    const res = await fetch(`${getServerUrl(server)}/make`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ made: true });
    server.close();
  });
});

describe('request hardening', () => {
  const getUrl = (s: import('http').Server) => `http://127.0.0.1:${(s.address() as any).port}`;

  it('rejects an over-size body with 413 and does not run the handler', async () => {
    let ran = false;
    const server = createHttpServer(
      [{ method: 'POST', pattern: '/echo', transport: 'buffer',
         handler: async () => { ran = true; return { status: 200, headers: {}, body: 'ok' }; } }],
      [], undefined, undefined, { limits: { maxBodyBytes: 16 } },
    );
    await new Promise<void>((r) => server.listen(0, r));
    const res = await fetch(`${getUrl(server)}/echo`, { method: 'POST', body: 'x'.repeat(1000) });
    expect(res.status).toBe(413);
    expect(ran).toBe(false);
    // Load-bearing, not cosmetic: without it the rest of the upload keeps arriving on a
    // kept-alive socket after the response. Node-only — `Connection` is a forbidden response
    // header on the fetch side, which is why the adapter attaches it rather than the shared core.
    expect(res.headers.get('connection')).toBe('close');
    server.close();
  });

  it('sets the configured server timeouts and connection limit', async () => {
    const server = createHttpServer([], [], undefined, undefined,
      { limits: { maxConnections: 2468, requestTimeoutMs: 12345, headersTimeoutMs: 6789, keepAliveTimeoutMs: 4321 } });
    expect(server.maxConnections).toBe(2468);
    expect(server.requestTimeout).toBe(12345);
    expect(server.headersTimeout).toBe(6789);
    expect(server.keepAliveTimeout).toBe(4321);
    server.close();
  });

  it('caps concurrent connections by default', () => {
    const server = createHttpServer([]);
    expect(server.maxConnections).toBe(1000);
    server.close();
  });

  it.each([0, -1])('treats maxConnections=%i as unlimited', (maxConnections) => {
    const server = createHttpServer([], [], undefined, undefined, {
      limits: { maxConnections },
    });
    expect(server.maxConnections).toBeUndefined();
    server.close();
  });

  it('rejects requests above maxConcurrentRequests and releases the slot afterwards', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const server = createHttpServer(
      [
        {
          method: 'GET',
          pattern: '/slow',
          transport: 'buffer',
          handler: async () => {
            await blocked;
            return { status: 200, headers: {}, body: 'ok' };
          },
        },
      ],
      [],
      undefined,
      undefined,
      { limits: { maxConcurrentRequests: 1 } },
    );

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const first = fetch(`${getUrl(server)}/slow`);

    // Give the first request time to acquire the only slot.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rejected = await fetch(`${getUrl(server)}/slow`);

    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(rejected.headers.get('connection')).toBe('close');

    release();

    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);

    const afterRelease = await fetch(`${getUrl(server)}/slow`);
    expect(afterRelease.status).toBe(200);

    server.close();
  });

  it('requestTimeout does NOT kill an in-flight SSE stream (streaming regression)', async () => {
    async function* feed() { for (let n = 1; n <= 3; n++) { yield { n }; await new Promise((r) => setTimeout(r, 80)); } }
    const server = createHttpServer(
      [{ method: 'GET', pattern: '/feed', transport: 'sse', handler: async () => ({ stream: feed() }) }],
      [], undefined, undefined, { limits: { requestTimeoutMs: 100 } },
    );
    await new Promise<void>((r) => server.listen(0, r));
    const res = await fetch(`${getUrl(server)}/feed`, { headers: { accept: 'text/event-stream' } });
    const text = await res.text();
    expect(text).toContain('data: {"n":1}');
    expect(text).toContain('data: {"n":3}');
    server.close();
  });

  it('parses application/x-www-form-urlencoded into an object body', async () => {
    const getUrl = (s: import('http').Server) => `http://127.0.0.1:${(s.address() as any).port}`;
    const server = createHttpServer([{
      method: 'POST', pattern: '/form', transport: 'buffer',
      handler: async (req) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body) }),
    }]);
    await new Promise<void>((r) => server.listen(0, r));
    const res = await fetch(`${getUrl(server)}/form`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=two',
    });
    expect(await res.json()).toEqual({ a: '1', b: 'two' });
    server.close();
  });
});
