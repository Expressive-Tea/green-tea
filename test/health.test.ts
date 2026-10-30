/**
 * CARD-17 (#115, D14): `createApp({ health })` serves `/__live__` and `/__ready__` outside the pipeline,
 * with booting / ok / degraded / draining states and a drain window on close(). Deno and Bun repeat
 * the drain case (T5) in their own suites; workerd covers T10 in `test/edge/run.ts`.
 */
import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { createApp, Route, Get, Ws, Module, Provider } from '../src/index';
import type { Logger } from '../src/logger';
import type { Plugin } from '../src/plugin';
import { encode, decode, MESH_PROTOCOL_VERSION } from '../src/mesh/protocol';

const silentLogger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let releaseSlow: () => void = () => {};

@Route('/')
class Ctl {
  @Get('/ping') ping() {
    return { ok: true };
  }

  // Held open until the test releases it: an in-flight request across close().
  @Get('/slow') async slow() {
    await new Promise<void>((resolve) => (releaseSlow = resolve));
    return { slow: true };
  }
}

@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

type AppOpts = Parameters<typeof createApp>[0];
const make = (extra: Partial<AppOpts> = {}) => createApp({ modules: [M], logger: silentLogger(), ...extra });

async function probe(app: ReturnType<typeof createApp>, path: string, method = 'GET') {
  const res = await app.fetch(new Request(`http://x${path}`, { method }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

describe('CARD-17: health probes through app.fetch', () => {
  it('T1: /__ready__ is 503 booting while a slow provider boots, /__live__ is 200', async () => {
    let finish: () => void = () => {};

    @Provider({ provides: 'slowDb' })
    class SlowDb {
      async provide() {
        await new Promise<void>((resolve) => (finish = resolve));
        return { slowDb: {} };
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl], providers: [SlowDb] })
    class Slow {}

    const app = createApp({ modules: [Slow], health: true, logger: silentLogger() });
    const booting = app.boot();
    await sleep(10);

    expect(await probe(app, '/__ready__')).toMatchObject({ status: 503, body: { status: 'booting' } });
    expect(await probe(app, '/__live__')).toMatchObject({ status: 200, body: { status: 'ok' } });

    finish();
    await booting;
    expect(await probe(app, '/__ready__')).toMatchObject({ status: 200, body: { status: 'ok' } });
  });

  it('T1: a probe before any boot starts the boot without waiting for it', async () => {
    let started = false;

    @Provider({ provides: 'watched' })
    class Watched {
      provide() {
        started = true;
        return { watched: {} };
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl], providers: [Watched] })
    class W {}

    const app = createApp({ modules: [W], health: true, logger: silentLogger() });
    expect((await probe(app, '/__ready__')).body).toEqual({ status: 'booting' });
    await sleep(10);
    expect(started).toBe(true);
    expect((await probe(app, '/__ready__')).body).toEqual({ status: 'ok' });
  });

  it('a failed boot keeps /__ready__ at 503 booting and still fails real requests', async () => {
    @Provider({ provides: 'broken' })
    class Broken {
      provide(): never {
        throw new Error('no pool');
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl], providers: [Broken] })
    class B {}

    const app = createApp({ modules: [B], health: true, logger: silentLogger() });
    await probe(app, '/__ready__');
    await sleep(10);
    expect(await probe(app, '/__ready__')).toMatchObject({ status: 503, body: { status: 'booting' } });
    await expect(app.fetch(new Request('http://x/ping'))).rejects.toThrow("provider 'broken' failed: no pool");
  });

  it('T2: booted with nothing degraded → 200 ok', async () => {
    const app = make({ health: true });
    await app.boot();
    expect(await probe(app, '/__ready__')).toMatchObject({ status: 200, body: { status: 'ok' } });
  });

  it('T3: an optional provider failed → 200 degraded with its name', async () => {
    @Provider({ provides: 'x', optional: true })
    class X {
      provide(): never {
        throw new Error('down');
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl], providers: [X] })
    class D {}

    const app = createApp({ modules: [D], health: true, logger: silentLogger() });
    await app.boot();
    expect(await probe(app, '/__ready__')).toMatchObject({
      status: 200,
      body: { status: 'degraded', degraded: ['x'] },
    });
  });

  it('T7: POST /__ready__ → 405 with Allow: GET, HEAD; HEAD answers with no body', async () => {
    const app = make({ health: true });
    await app.boot();

    const post = await probe(app, '/__ready__', 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');

    const head = await probe(app, '/__live__', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();
  });

  it('security headers are injected, cache-control is no-store, a query string is ignored', async () => {
    const app = make({ health: true });
    await app.boot();
    const res = await probe(app, '/__ready__?verbose=1');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('T9 + rule 5: no lifecycle event, no plugin step, no log line for a probe', async () => {
    const step = vi.fn(() => ({}));
    const plugin: Plugin = {
      name: 'global-step',
      mount(api) {
        api.scope.add({ kind: 'step', name: 'everywhere', needs: [], provides: [], run: step });
      },
    };
    const logger = silentLogger();
    const app = createApp({ modules: [M], plugins: [plugin], health: true, logRequests: true, logger });
    await app.boot();
    const emit = vi.spyOn(app.bus, 'emit');

    for (let i = 0; i < 10; i++) await probe(app, i % 2 ? '/__live__' : '/__ready__');

    expect(emit).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();

    // the control: an ordinary request does run the step and log
    await app.fetch(new Request('http://x/ping'));
    expect(step).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('T6: probes answer while maxConcurrentRequests sheds everything else', async () => {
    const app = make({ health: true, limits: { maxConcurrentRequests: 1 } });
    await app.boot();
    const held = app.fetch(new Request('http://x/slow'));
    await sleep(10);

    expect((await app.fetch(new Request('http://x/ping'))).status).toBe(503);
    expect((await probe(app, '/__ready__')).status).toBe(200);
    expect((await probe(app, '/__live__')).status).toBe(200);

    releaseSlow();
    expect((await held).status).toBe(200);
  });

  it('health off: the probe paths are ordinary paths (404)', async () => {
    const app = make();
    expect((await app.fetch(new Request('http://x/__ready__'))).status).toBe(404);
  });

  it('draining after close() on an app served through app.fetch', async () => {
    const app = make({ health: true });
    await app.boot();
    await app.close();
    expect(await probe(app, '/__ready__')).toMatchObject({ status: 503, body: { status: 'draining' } });
    expect((await probe(app, '/__live__')).status).toBe(200);
  });
});

describe('CARD-17: health option validation and reserved paths', () => {
  it('invalid health values throw at createApp', () => {
    expect(() => make({ health: 'yes' as never })).toThrow(/health must be true, false or \{ drainDelayMs/);
    expect(() => make({ health: { drainDelayMs: -1 } })).toThrow(/drainDelayMs must be a non-negative number/);
    expect(() => make({ health: { drainDelayMs: Number.NaN } })).toThrow(/non-negative number/);
    expect(() => make({ health: { checks: [] } as never })).toThrow(/unknown option 'checks'/);
    expect(() => make({ health: { drainDelayMs: 20_000 } })).toThrow(/cannot exceed shutdownTimeoutMs \(10000\)/);
    expect(() => make({ health: { drainDelayMs: 600 }, shutdownTimeoutMs: 1000, teardownTimeoutMs: 500 })).toThrow(
      /plus teardownTimeoutMs \(500\)/,
    );
    expect(() => make({ health: { drainDelayMs: 500 } })).not.toThrow();
    expect(() => make({ health: false })).not.toThrow();
  });

  it('T8: @Get(/__live__) with health on fails createApp, naming the route', () => {
    @Route('/')
    class Own {
      @Get('/__live__') live() {
        return {};
      }
    }
    @Module({ mountpoint: '/', controllers: [Own] })
    class O {}

    expect(() => createApp({ modules: [O], health: true })).toThrow(
      'route GET /__live__ at Own.live uses the reserved path /__live__ (the liveness probe, health: true) — ' +
        'green-tea answers that path itself on every runtime, so no route may declare it. Move the route.',
    );
  });

  it('a route at /__ready__ (HTTP or WS) fails with health on and serves with it off', async () => {
    @Route('/')
    class Own {
      @Get('/__ready__') ready() {
        return { mine: true };
      }
    }
    @Module({ mountpoint: '/', controllers: [Own] })
    class O {}
    @Route('/')
    class OwnWs {
      @Ws('/__ready__') ready() {
        return (async function* () {})();
      }
    }
    @Module({ mountpoint: '/', controllers: [OwnWs] })
    class OW {}

    expect(() => createApp({ modules: [O], health: true })).toThrow(/^route GET \/__ready__ at Own\.ready uses/);
    expect(() => createApp({ modules: [OW], health: true })).toThrow(/^route @Ws \/__ready__ at OwnWs\.ready uses/);

    const off = createApp({ modules: [O] });
    expect(await (await off.fetch(new Request('http://x/__ready__'))).json()).toEqual({ mine: true });
  });

  it('a teapot route at /__ready__ fails the teacup splice while health is on', async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        if (decode(data.toString()).type === 'hello') {
          ws.send(
            encode({
              type: 'manifest',
              v: MESH_PROTOCOL_VERSION,
              steps: [],
              routes: [{ method: 'GET', pattern: '/__ready__' }],
            }),
          );
        }
      });
    });
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/__mesh__/control`;
    const teacup = createApp({
      modules: [M],
      health: true,
      experimental: true,
      mesh: { teapots: [{ url, secret: 's' }] },
      logger: silentLogger(),
    });

    try {
      await expect(teacup.ready()).rejects.toThrow(
        `mesh: remote route 'GET /__ready__' from ${url} uses the reserved path /__ready__`,
      );
    } finally {
      await teacup.close();
      wss.close();
    }
  });
});

/** One request on `agent` (kept alive), resolving with status and body. */
function request(port: number, path: string, agent: http.Agent) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('CARD-17: the Node listener', () => {
  const agents: http.Agent[] = [];

  afterEach(() => agents.splice(0).forEach((agent) => agent.destroy()));

  it('serves the probes before the gate; listen() boots first, so the listener never says booting', async () => {
    const app = make({ health: true });
    const server = await app.listen(0);
    const agent = new http.Agent({ keepAlive: true });
    agents.push(agent);

    try {
      const port = (server.address() as AddressInfo).port;
      expect(await request(port, '/__ready__', agent)).toEqual({ status: 200, body: '{"status":"ok"}' });
      expect(await request(port, '/__live__', agent)).toEqual({ status: 200, body: '{"status":"ok"}' });
    } finally {
      await app.close();
    }
  });

  it('T4: close() flips /__ready__ to 503 on a kept-alive connection while a slow request completes', async () => {
    const app = make({ health: { drainDelayMs: 300 } });
    const server = await app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const slowAgent = new http.Agent({ keepAlive: true });
    agents.push(agent, slowAgent);

    // Warm the probe connection so the next probe reuses it.
    expect((await request(port, '/__ready__', agent)).status).toBe(200);
    const slow = request(port, '/slow', slowAgent);
    await sleep(20);

    const closing = app.close();
    const drained = await request(port, '/__ready__', agent);
    expect(drained).toEqual({ status: 503, body: '{"status":"draining"}' });

    releaseSlow();
    expect(await slow).toEqual({ status: 200, body: '{"slow":true}' });
    await closing;
  });

  it('T4 without drainDelayMs: close() still marks the app draining before it drains', async () => {
    const app = make({ health: true });
    await app.listen(0);
    await app.close();
    expect((await probe(app, '/__ready__')).body).toEqual({ status: 'draining' });
  });

  it('the drain window comes out of the close() budget', async () => {
    const app = make({ health: { drainDelayMs: 200 } });
    await app.listen(0);
    const started = Date.now();
    await app.close({ timeoutMs: 1000 });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(1000);
  });

  it('a POST probe on the listener answers 405 with Allow', async () => {
    const app = make({ health: true });
    const server = await app.listen(0);

    try {
      const port = (server.address() as AddressInfo).port;
      const res = await new Promise<http.IncomingMessage>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/__ready__', method: 'POST' }, resolve);
        req.end();
      });
      res.resume();
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
      expect(res.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
    }
  });
});
