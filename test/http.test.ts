import { describe, expect, it, test, vi } from 'vitest';
import * as net from 'node:net';
import { ServerResponse } from 'node:http';
import { once } from 'node:events';
import { Bus } from '../src/bus';
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

  it('warns when maxConnections drops a real connection and throttles repeated warnings', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const server = createHttpServer([], [], undefined, undefined, {
      logger,
      limits: { maxConnections: 1 },
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');

    const first = net.createConnection({ host: '127.0.0.1', port: address.port });
    await once(first, 'connect');

    const waitForClose = (socket: net.Socket): Promise<void> =>
      new Promise((resolve) => {
        socket.on('error', () => undefined);
        socket.once('close', () => resolve());
      });

    const second = net.createConnection({ host: '127.0.0.1', port: address.port });
    const third = net.createConnection({ host: '127.0.0.1', port: address.port });
    const secondClosed = waitForClose(second);
    const thirdClosed = waitForClose(third);

    try {
      await Promise.all([secondClosed, thirdClosed]);

      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('maxConnections (1) reached \u2014 dropped connection from'),
        expect.objectContaining({
          maxConnections: 1,
          remoteAddress: '127.0.0.1',
        }),
      );
    } finally {
      first.destroy();
      second.destroy();
      third.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects requests above maxConcurrentRequests and releases the slot afterwards', async () => {
    let release!: () => void;
    let started!: () => void;

    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const bus = new Bus();
    const ended: Array<{ method?: string; status?: number; requestId?: string }> = [];
    bus.on('request:end', (event) => {
      ended.push(event);
    });

    const server = createHttpServer(
      [
        {
          method: 'GET',
          pattern: '/slow',
          transport: 'buffer',
          handler: async () => {
            started();
            await blocked;
            return { status: 200, headers: {}, body: 'ok' };
          },
        },
      ],
      [],
      bus,
      undefined,
      {
        limits: { maxConcurrentRequests: 1 },
        cors: { origins: 'https://example.com' },
      },
    );

    await new Promise<void>((resolve) => server.listen(0, resolve));

    const first = fetch(`${getUrl(server)}/slow`);
    await firstStarted;

    const rejected = await fetch(`${getUrl(server)}/slow`, {
      headers: { origin: 'https://example.com' },
    });

    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('content-type')).toBe('application/json');
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(rejected.headers.get('connection')).toBe('close');
    expect(rejected.headers.get('access-control-allow-origin')).toBe('https://example.com');
    expect(rejected.headers.get('x-content-type-options')).toBe('nosniff');
    expect(rejected.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    await expect(rejected.json()).resolves.toEqual({ error: 'Service Unavailable' });

    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      method: 'GET',
      status: 503,
    });
    expect(ended[0].requestId).toBeTruthy();

    release();

    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);

    const afterRelease = await fetch(`${getUrl(server)}/slow`);
    expect(afterRelease.status).toBe(200);

    server.close();
  });

  it('releases a request slot when the client disconnects before the handler settles', async () => {
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const server = createHttpServer(
      [
        {
          method: 'GET',
          pattern: '/hang',
          transport: 'buffer',
          handler: async () => {
            started();
            await new Promise(() => {});
            return { status: 200, headers: {}, body: 'never' };
          },
        },
        {
          method: 'GET',
          pattern: '/ok',
          transport: 'buffer',
          handler: async () => ({ status: 200, headers: {}, body: 'ok' }),
        },
      ],
      [],
      undefined,
      undefined,
      { limits: { maxConcurrentRequests: 1 } },
    );

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');

    const responseClosed = new Promise<void>((resolve) => {
      server.once('request', (_req, res) => {
        res.once('close', resolve);
      });
    });

    const client = net.createConnection({ host: '127.0.0.1', port: address.port });
    await once(client, 'connect');
    client.write('GET /hang HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');

    await handlerStarted;
    client.destroy();
    await responseClosed;

    const afterDisconnect = await fetch(`${getUrl(server)}/ok`);
    expect(afterDisconnect.status).toBe(200);

    await new Promise<void>((resolve) => server.close(() => resolve()));
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

  it('a cors.origins predicate that throws answers the request instead of taking the process down', async () => {
    const warn = vi.fn();
    const server = createHttpServer(
      [{ method: 'GET', pattern: '/ping', transport: 'buffer', handler }],
      [],
      undefined,
      undefined,
      {
        cors: {
          origins: () => {
            throw new Error('lookup failed');
          },
        },
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as any,
      },
    );
    await new Promise<void>((r) => server.listen(0, r));

    // Only a request carrying an Origin reaches the predicate — which is why a suite that forgets
    // the header watches this crash in production instead.
    const res = await fetch(`${getUrl(server)}/ping`, { headers: { origin: 'https://a.com' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(warn).toHaveBeenCalled();

    // The security headers still land: one broken predicate must not strip the rest.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    server.close();
  });


  // `origins` is a predicate because the shapes it exists for are lookups — an allowlist in Redis, a
  // tenant query. Running one twice for a GET and three times for a preflight charges the caller's
  // latency budget and their backend for an answer whose inputs did not change in between.
  it('consults a cors.origins predicate once per request, not once per header computation', async () => {
    let calls = 0;
    const server = createHttpServer(
      [{ method: 'GET', pattern: '/ping', transport: 'buffer', handler }],
      [], undefined, undefined,
      { cors: { origins: () => { calls++; return true; } } },
    );
    await new Promise<void>((r) => server.listen(0, r));
    const origin = { origin: 'https://a.com' };

    const plain = await fetch(`${getUrl(server)}/ping`, { headers: origin });
    expect(plain.headers.get('access-control-allow-origin')).toBe('https://a.com');
    expect(calls).toBe(1);

    calls = 0;
    const preflight = await fetch(`${getUrl(server)}/ping`, {
      method: 'OPTIONS', headers: { ...origin, 'access-control-request-method': 'GET' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('GET');
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://a.com');
    expect(calls).toBe(1);

    // No Origin header never reaches the predicate at all — that part was already right.
    calls = 0;
    await fetch(`${getUrl(server)}/ping`);
    expect(calls).toBe(0);

    server.close();
  });


  // `maxConcurrentRequests` is opt-in and unlimited by default, so the overwhelming majority of
  // apps used to pay a closure and an EventEmitter registration per request for a feature that is
  // off. Small in absolute terms, and on the hot path, which is why it is asserted rather than
  // trusted: a `res.once('close')` is exactly the kind of line that comes back.
  it('registers no per-request close listener when no request budget is configured', async () => {
    const closeListeners: string[] = [];
    // Typed loosely on purpose: `once` is an overloaded EventEmitter signature and the spy only
    // needs to see the event name before handing the call straight back to the real one.
    const proto = ServerResponse.prototype as unknown as {
      once(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
    };
    const realOnce = proto.once;
    const spy = vi.spyOn(proto, 'once').mockImplementation(function (this: unknown, event, listener) {
      if (event === 'close') closeListeners.push('close');
      return realOnce.call(this, event, listener);
    });

    try {
      const unlimited = createHttpServer([{ method: 'GET', pattern: '/ping', transport: 'buffer', handler }]);
      await new Promise<void>((r) => unlimited.listen(0, r));
      expect((await fetch(`${getUrl(unlimited)}/ping`)).status).toBe(200);
      expect(closeListeners).toHaveLength(0);
      unlimited.close();

      // With a budget set, the listener is what releases the slot on a client disconnect, so it
      // has to come back — the guard is about the unset case, not about dropping the feature.
      const limited = createHttpServer(
        [{ method: 'GET', pattern: '/ping', transport: 'buffer', handler }],
        [], undefined, undefined,
        { limits: { maxConcurrentRequests: 4 } },
      );
      await new Promise<void>((r) => limited.listen(0, r));
      expect((await fetch(`${getUrl(limited)}/ping`)).status).toBe(200);
      expect(closeListeners.length).toBeGreaterThan(0);
      limited.close();
    } finally {
      spy.mockRestore();
    }
  });

});
