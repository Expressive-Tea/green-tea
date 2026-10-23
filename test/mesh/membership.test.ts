/**
 * CARD-19 (#124, D15): a teacup's remote routes follow which teapots are connected.
 *
 * Late teapot → its routes are added. Reconnecting → they stay and answer 503 with `retry-after`.
 * Gone for good → they are removed (404, `Allow` without them). A returning manifest adds and drops
 * routes. A late route that conflicts is refused and logged. Every change emits `mesh:routes`, and
 * none rebuilds the local route tree.
 */
import 'reflect-metadata';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { encode, decode, MESH_PROTOCOL_VERSION, type RouteEntry } from '../../src/mesh/protocol';
import { createApp, Route, Get, Module } from '../../src/index';
import { routerSeamCounts } from '../../src/http/router';
import type { App, MeshConfig } from '../../src/app/types';
import type { EventPayload } from '../../src/bus';

const SECRET = 'membership-secret';

@Route('/remote')
class PingCtl {
  @Get('/ping', { export: true }) ping() {
    return { from: 'teapot' };
  }
}
@Module({ mountpoint: '/api', controllers: [PingCtl] })
class PingTeapot {}

@Route('/remote')
class PingExtraCtl {
  @Get('/ping', { export: true }) ping() {
    return { from: 'teapot v2' };
  }
  @Get('/extra', { export: true }) extra() {
    return { extra: true };
  }
}
@Module({ mountpoint: '/api', controllers: [PingExtraCtl] })
class PingExtraTeapot {}

@Route('/remote')
class ExtraOnlyCtl {
  @Get('/extra', { export: true }) extra() {
    return { extra: true };
  }
}
@Module({ mountpoint: '/api', controllers: [ExtraOnlyCtl] })
class ExtraOnlyTeapot {}

@Route('/shape')
class ShapeIdCtl {
  @Get('/:id', { export: true }) get() {
    return { from: 'id' };
  }
}
@Module({ mountpoint: '/api', controllers: [ShapeIdCtl] })
class ShapeIdTeapot {}

@Route('/')
class ShapeNameCtl {
  @Get('/shape/:name', { export: true }) get() {
    return { from: 'name' };
  }
  @Get('/other', { export: true }) other() {
    return { from: 'other' };
  }
}
@Module({ mountpoint: '/api', controllers: [ShapeNameCtl] })
class ShapeNameTeapot {}

@Route('/local')
class LocalCtl {
  @Get('/ok') ok() {
    return { from: 'teacup' };
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

const FAST = { initialDelayMs: 20, maxDelayMs: 60 };

/** A port nothing listens on, that a teapot can take later. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const controlUrl = (port: number) => `ws://127.0.0.1:${port}/__mesh__/control`;

const open: App[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function teapotOn(port: number, module: new () => unknown): Promise<App> {
  const teapot = createApp({ modules: [module], experimental: true, mesh: { secret: SECRET } });
  await teapot.listen(port);
  open.push(teapot);
  return teapot;
}

async function stop(teapot: App): Promise<void> {
  await teapot.close();
  open.splice(open.indexOf(teapot), 1);
}

interface Teacup {
  app: App;
  warnings: string[];
  events: EventPayload[];
  /** Resolves on the next `name` event. */
  next: (name: 'mesh:routes' | 'mesh:disconnect') => Promise<EventPayload>;
}

function teacup(ports: number[], mesh: Partial<MeshConfig> = {}, extra: { health?: boolean } = {}): Teacup {
  const warnings: string[] = [];
  const events: EventPayload[] = [];
  const waiting = new Map<string, Array<(e: EventPayload) => void>>();
  const app = createApp({
    modules: [TeacupModule],
    experimental: true,
    ...extra,
    logger: { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error: (m: string) => warnings.push(m) },
    mesh: {
      teapots: ports.map((port) => ({ url: controlUrl(port), secret: SECRET })),
      bootTimeoutMs: 100,
      timeoutMs: 1000,
      heartbeatMs: 1000,
      reconnect: FAST,
      ...mesh,
    },
  });

  for (const name of ['mesh:routes', 'mesh:disconnect'] as const) {
    app.bus.on(name, (payload) => {
      if (name === 'mesh:routes') events.push(payload);
      const list = waiting.get(name) ?? [];
      waiting.delete(name);
      for (const resolve of list) resolve(payload);
    });
  }

  open.unshift(app); // closed before the teapots
  const next = (name: string) =>
    new Promise<EventPayload>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${name} within 5s`)), 5000);
      waiting.set(name, [
        ...(waiting.get(name) ?? []),
        (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      ]);
    });
  return { app, warnings, events, next };
}

const get = (app: App, path: string, method = 'GET') => app.fetch(new Request(`http://mesh.test${path}`, { method }));

function nodeGet(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * A teapot speaking the wire protocol directly, so its manifest can carry what a real teapot's own
 * boot refuses — an older or foreign peer advertising a reserved path. Every RPC answers `answer`.
 */
async function rawTeapotOn(
  port: number,
  routes: RouteEntry[],
  answer: unknown,
): Promise<{ close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const frame = decode(data.toString());
      if (frame.type === 'hello') ws.send(encode({ type: 'manifest', v: MESH_PROTOCOL_VERSION, steps: [], routes }));
      else if (frame.type === 'ping') ws.send(encode({ type: 'pong' }));
      else if (frame.type === 'rpc-req')
        ws.send(
          encode({
            type: 'rpc-res',
            id: frame.id,
            ok: true,
            result: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer) },
          }),
        );
    });
  });
  await new Promise((resolve) => wss.on('listening', resolve));

  return {
    close: () =>
      new Promise<void>((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => done());
      }),
  };
}

describe('mesh: remote routes follow teapot membership (CARD-19, D15)', () => {
  it('T1: a teapot absent at boot is served once it connects, on app.fetch and listen(), without rebuilding the local tree', async () => {
    const port = await freePort();
    const cup = teacup([port]);
    const listenPort = ((await cup.app.listen(0)).address() as AddressInfo).port;

    expect((await get(cup.app, '/api/remote/ping')).status).toBe(404);
    expect((await get(cup.app, '/api/local/ok')).status).toBe(200);
    const before = routerSeamCounts();

    const routed = cup.next('mesh:routes');
    await teapotOn(port, PingTeapot);
    expect(await routed).toEqual({
      name: controlUrl(port),
      url: controlUrl(port),
      added: ['GET /api/remote/ping'],
      removed: [],
    });

    const res = await get(cup.app, '/api/remote/ping');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ from: 'teapot' });
    expect(await nodeGet(listenPort, '/api/remote/ping')).toEqual({ status: 200, body: '{"from":"teapot"}' });
    expect((await get(cup.app, '/api/local/ok')).status).toBe(200);

    const after = routerSeamCounts();
    expect(after.indexBuilds).toBeGreaterThan(before.indexBuilds); // the remote trees were rebuilt
    expect(after.localTreeBuilds).toBe(before.localTreeBuilds); // the local ones were not
  });

  it('T2/T3: a reconnecting teapot keeps its routes with 503 + retry-after, then serves again', async () => {
    const port = await freePort();
    let teapot = await teapotOn(port, PingTeapot);
    const cup = teacup([port]);
    expect((await get(cup.app, '/api/remote/ping')).status).toBe(200);

    const dropped = cup.next('mesh:disconnect');
    await stop(teapot);
    await dropped;

    const down = await get(cup.app, '/api/remote/ping');
    expect(down.status).toBe(503);
    expect(Number(down.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await get(cup.app, '/api/remote/ping', 'OPTIONS')).headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect((await get(cup.app, '/api/remote/ping', 'POST')).headers.get('allow')).toBe('GET, HEAD, OPTIONS');

    teapot = await teapotOn(port, PingTeapot);
    await expect.poll(async () => (await get(cup.app, '/api/remote/ping')).status, { timeout: 5000 }).toBe(200);
    // Same routes back: nothing changed in the table, so no event.
    expect(cup.events).toEqual([]);
  });

  it('T4: with reconnect: false a dropped teapot is gone — 404, Allow without its methods, local routes unaffected', async () => {
    const port = await freePort();
    const teapot = await teapotOn(port, PingTeapot);
    const cup = teacup([port], { reconnect: false });
    expect((await get(cup.app, '/api/remote/ping')).status).toBe(200);

    const routed = cup.next('mesh:routes');
    await stop(teapot);
    expect(await routed).toMatchObject({ added: [], removed: ['GET /api/remote/ping'] });

    const gone = await get(cup.app, '/api/remote/ping');
    expect(gone.status).toBe(404);
    expect(gone.headers.get('retry-after')).toBeNull();
    const options = await get(cup.app, '/api/remote/ping', 'OPTIONS');
    expect(options.status).toBe(404);
    expect(options.headers.get('allow')).toBeNull();
    expect((await get(cup.app, '/api/local/ok')).status).toBe(200);
    expect(cup.warnings.some((w) => w.includes('gone for good'))).toBe(true);
  });

  it('T5: a teapot that returns with an extra route has it served', async () => {
    const port = await freePort();
    const teapot = await teapotOn(port, PingTeapot);
    const cup = teacup([port]);
    expect((await get(cup.app, '/api/remote/extra')).status).toBe(404);

    const dropped = cup.next('mesh:disconnect');
    await stop(teapot);
    await dropped;
    const routed = cup.next('mesh:routes');
    await teapotOn(port, PingExtraTeapot);
    expect(await routed).toMatchObject({ added: ['GET /api/remote/extra'], removed: [] });

    expect((await get(cup.app, '/api/remote/extra')).status).toBe(200);
    expect(await (await get(cup.app, '/api/remote/ping')).json()).toEqual({ from: 'teapot v2' });
  });

  it('T6: a teapot that returns without a route has it removed', async () => {
    const port = await freePort();
    const teapot = await teapotOn(port, PingTeapot);
    const cup = teacup([port]);
    expect((await get(cup.app, '/api/remote/ping')).status).toBe(200);

    const dropped = cup.next('mesh:disconnect');
    await stop(teapot);
    await dropped;
    const routed = cup.next('mesh:routes');
    await teapotOn(port, ExtraOnlyTeapot);
    expect(await routed).toMatchObject({ added: ['GET /api/remote/extra'], removed: ['GET /api/remote/ping'] });

    expect((await get(cup.app, '/api/remote/ping')).status).toBe(404);
    expect((await get(cup.app, '/api/remote/extra')).status).toBe(200);
  });

  it('T7: a late route ambiguous with another teapot’s is refused and logged; everything else serves', async () => {
    const [portA, portB] = [await freePort(), await freePort()];
    await teapotOn(portA, ShapeIdTeapot);
    const cup = teacup([portA, portB]);
    expect(await (await get(cup.app, '/api/shape/1')).json()).toEqual({ from: 'id' });

    const routed = cup.next('mesh:routes');
    await teapotOn(portB, ShapeNameTeapot);
    expect(await routed).toMatchObject({ url: controlUrl(portB), added: ['GET /api/other'], removed: [] });

    expect(await (await get(cup.app, '/api/shape/1')).json()).toEqual({ from: 'id' });
    expect((await get(cup.app, '/api/other')).status).toBe(200);
    expect(
      cup.warnings.some((w) => w.includes('not serving a route from') && w.includes("'GET /api/shape/:name'")),
    ).toBe(true);
  });

  it('T8: 1 000 requests across a late connect each see the old table or the new one', async () => {
    const port = await freePort();
    const cup = teacup([port]);
    expect((await get(cup.app, '/api/remote/ping')).status).toBe(404);

    const routed = cup.next('mesh:routes');
    const starting = teapotOn(port, PingTeapot);
    const statuses: number[] = [];
    let changed = false;
    void routed.then(() => (changed = true));

    // 100 waves of 10 concurrent requests, spread across the moment the table changes. Ten at a time,
    // not more: past 16 RPCs in flight on one link the teapot's control channel hits the WebSocket
    // inbound-queue bound (#107) and drops the link. That is pre-existing and not about membership.
    for (let wave = 0; wave < 100; wave++) {
      const batch = await Promise.all(
        Array.from({ length: 10 }, () => get(cup.app, '/api/remote/ping').then((res) => res.status)),
      );
      statuses.push(...batch);
      if (!changed) await new Promise((resolve) => setTimeout(resolve, 2));
    }

    await starting;
    await routed;

    expect(statuses).toHaveLength(1000);
    expect(statuses.every((status) => status === 404 || status === 200)).toBe(true);
    // Both tables were actually seen, so the change happened while requests were flowing.
    expect(statuses).toContain(404);
    expect(statuses).toContain(200);
    expect((await get(cup.app, '/api/remote/ping')).status).toBe(200);
  });

  it('with reconnect: false a teapot absent at boot is not retried (no backoff to retry with)', async () => {
    const port = await freePort();
    const cup = teacup([port], { reconnect: false });
    expect((await get(cup.app, '/api/remote/ping')).status).toBe(404);
    await teapotOn(port, PingTeapot);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await get(cup.app, '/api/remote/ping')).status).toBe(404);
    expect(cup.events).toEqual([]);
  });
  it('a late teapot advertising /__mesh__/control has that route refused; its other routes are served', async () => {
    const port = await freePort();
    const cup = teacup([port]);
    expect((await get(cup.app, '/api/fake/ok')).status).toBe(404);

    const routed = cup.next('mesh:routes');
    const raw = await rawTeapotOn(
      port,
      [
        { method: 'GET', pattern: '/__mesh__/control' },
        { method: 'GET', pattern: '/api/fake/ok' },
      ],
      { from: 'raw teapot' },
    );

    try {
      expect(await routed).toMatchObject({ added: ['GET /api/fake/ok'], removed: [] });
      expect(await (await get(cup.app, '/api/fake/ok')).json()).toEqual({ from: 'raw teapot' });
      expect(await (await get(cup.app, '/__mesh__/control')).text()).not.toContain('raw teapot');
      expect(
        cup.warnings.some((w) => w.includes('not serving a route from') && w.includes("'GET /__mesh__/control'")),
      ).toBe(true);
    } finally {
      await cup.app.close();
      open.splice(open.indexOf(cup.app), 1);
      await raw.close();
    }
  });

  it('with health on, a late teapot advertising /__ready__ has that route refused; its other routes are served', async () => {
    const port = await freePort();
    const cup = teacup([port], {}, { health: true });
    expect((await get(cup.app, '/api/fake/ok')).status).toBe(404);

    const routed = cup.next('mesh:routes');
    const raw = await rawTeapotOn(
      port,
      [
        { method: 'GET', pattern: '/__ready__' },
        { method: 'GET', pattern: '/api/fake/ok' },
      ],
      { from: 'raw teapot' },
    );

    try {
      expect(await routed).toMatchObject({ added: ['GET /api/fake/ok'], removed: [] });
      expect((await get(cup.app, '/api/fake/ok')).status).toBe(200);
      expect(await (await get(cup.app, '/__ready__')).text()).not.toContain('raw teapot');
      expect(cup.warnings.some((w) => w.includes('not serving a route from') && w.includes("'GET /__ready__'"))).toBe(
        true,
      );
    } finally {
      await cup.app.close();
      open.splice(open.indexOf(cup.app), 1);
      await raw.close();
    }
  });
});
