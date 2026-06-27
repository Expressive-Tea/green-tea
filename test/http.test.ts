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
