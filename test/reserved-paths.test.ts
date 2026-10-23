/**
 * CARD-21 (#126, D17): `/__mesh__/control` is reserved in every app, mesh or not. Boot refuses a route
 * that claims it, and an upgrade to it on an app without a control channel is refused the same way
 * by the Node listener and by `app.upgrade`. Deno, Bun and workerd repeat T1/T5 in their own suites.
 */
import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'net';
import type http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp, Route, Get, Post, Ws, Stream, Module, param, MESH_CONTROL_PATH } from '../src/index';
import type { RouteDecorator } from '../src/metadata';
import { channel } from '../src/channel';
import type { WsRequest, WsSocket } from '../src/http/ws-core';
import { claimedReservedPath } from '../src/http/reserved-paths';
import { encode, decode, MESH_PROTOCOL_VERSION } from '../src/mesh/protocol';

const REASON = 'mesh control channel not enabled: this app exports nothing, or has no mesh.secret';
const RESERVED = [{ path: MESH_CONTROL_PATH, purpose: 'the mesh control channel' }];

type Decl = [RouteDecorator, string];

/** One controller under `mountpoint`, a handler per declaration (`h0`, `h1`, …). */
function moduleWith(decls: Decl[], mountpoint = '/', name = 'Routes') {
  const Routes = { [name]: class {} }[name];

  decls.forEach(([decorator, path], index) => {
    const handler = `h${index}`;
    Object.defineProperty(Routes.prototype, handler, {
      value: (p: Record<string, string>) =>
        (async function* () {
          yield { route: handler, params: p };
        })(),
      configurable: true,
    });
    param()(Routes.prototype, handler, 0);
    decorator(path)(Routes.prototype, handler, Object.getOwnPropertyDescriptor(Routes.prototype, handler)!);
  });

  Route('/')(Routes);
  class RoutesModule {}
  Module({ mountpoint, controllers: [Routes] })(RoutesModule);
  return RoutesModule;
}

const bootError = (decls: Decl[], mountpoint?: string): string => {
  try {
    createApp({ modules: [moduleWith(decls, mountpoint)] });
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected the app to refuse to boot');
};

describe('CARD-21: a route on the reserved mesh path fails createApp', () => {
  it('T1: @Ws(/__mesh__/control) on a non-mesh app', () => {
    expect(bootError([[Ws, '/__mesh__/control']])).toBe(
      'route @Ws /__mesh__/control at Routes.h0 uses the reserved path /__mesh__/control (the mesh control channel) — ' +
        'green-tea answers that path itself on every runtime, so no route may declare it. Move the route.',
    );
  });

  it('T2: @Get(/__mesh__/control)', () => {
    expect(bootError([[Get, '/__mesh__/control']])).toMatch(
      /^route GET \/__mesh__\/control at Routes\.h0 uses the reserved path \/__mesh__\/control/,
    );
  });

  it('T3: @Ws(/__mesh__/:x) — a parameterised pattern is checked by matching', () => {
    expect(bootError([[Ws, '/__mesh__/:x']])).toMatch(/^route @Ws \/__mesh__\/:x at Routes\.h0 uses the reserved path/);
  });

  it('@Stream, other methods, catch-alls, a trailing slash and a mountpoint are caught too', () => {
    expect(bootError([[Stream, '/__mesh__/control']])).toMatch(/^route @Stream \/__mesh__\/control at/);
    expect(bootError([[Post, '/__mesh__/control']])).toMatch(/^route POST /);
    expect(bootError([[Get, '/__mesh__/:rest*']])).toMatch(/uses the reserved path/);
    expect(bootError([[Get, '/__mesh__/control/']])).toMatch(/uses the reserved path/);
    expect(bootError([[Get, '/control']], '/__mesh__')).toMatch(/^route GET \/__mesh__\/control at/);
    expect(bootError([[Get, '/__mesh__/:x(c.*)']])).toMatch(/uses the reserved path/);
  });

  it('a mesh-enabled app gets the same refusal: the reservation does not depend on the mesh', () => {
    expect(() =>
      createApp({
        modules: [moduleWith([[Ws, '/__mesh__/control']])],
        experimental: true,
        mesh: { secret: 's' },
      }),
    ).toThrow(/uses the reserved path \/__mesh__\/control/);
  });

  it('patterns that do not name the reserved prefix still boot (the path is carved out of them)', () => {
    expect(() =>
      createApp({
        modules: [
          moduleWith([
            [Get, '/:org/:repo'],
            [Get, '/__mesh__/other'],
            [Get, '/__mesh__/:x(\\d+)'],
            [Get, '/__mesh__'],
            [Get, '/__mesh__/control/deeper'],
          ]),
        ],
      }),
    ).not.toThrow();
    expect(() => createApp({ modules: [moduleWith([[Ws, '/:a/:b']])] })).not.toThrow();
    expect(() => createApp({ modules: [moduleWith([[Get, '/:rest*']])] })).not.toThrow();
  });

  it('claimedReservedPath: literal by equality, parameterised by matching, prefix spelled literally', () => {
    expect(claimedReservedPath('/__mesh__/control', RESERVED)).toEqual(RESERVED[0]);
    expect(claimedReservedPath('/__mesh__/:x', RESERVED)).toEqual(RESERVED[0]);
    expect(claimedReservedPath('/__mesh__/:rest*', RESERVED)).toEqual(RESERVED[0]);
    expect(claimedReservedPath('/:a/control', RESERVED)).toBeUndefined();
    expect(claimedReservedPath('/:rest*', RESERVED)).toBeUndefined();
    expect(claimedReservedPath('/', RESERVED)).toBeUndefined();
    expect(claimedReservedPath('/__mesh__/:x(\\d+)', RESERVED)).toBeUndefined();
  });
});

/** Drives `app.upgrade` with an in-memory socket and records what it sent and how it closed. */
async function viaAppUpgrade(app: ReturnType<typeof createApp>, path: string) {
  const sent: unknown[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const ac = new AbortController();
  let open = true;
  const socket: WsSocket = {
    inbound: channel<unknown>(),
    abort: ac.signal,
    get isOpen() {
      return open;
    },
    send: (data) => sent.push(data),
    close: (code, reason) => {
      open = false;
      closes.push({ code, reason });
      ac.abort();
    },
    terminate: () => {
      open = false;
      ac.abort();
    },
  };
  const request: WsRequest = { url: path, headers: {}, protocol: 'http', ip: '127.0.0.1' };
  await app.upgrade(request, socket);
  return { sent, closes };
}

/** Opens a `ws` client on the Node listener and resolves with the HTTP status or the close frame. */
function viaNodeUpgrade(port: number, path: string) {
  return new Promise<{ status: number; close?: { code: number; reason: string } }>((resolve) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    client.on('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 });
      res.resume();
      client.terminate();
    });
    client.on('close', (code, reason) => resolve({ status: 101, close: { code, reason: String(reason) } }));
    client.on('error', () => {});
  });
}

describe('CARD-21: an upgrade to the reserved path on an app with no control channel', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  const ordinary = () => moduleWith([[Ws, '/echo']], '/', 'Ordinary');

  it('T4: the Node listener accepts and closes 1008 with the app.upgrade reason', async () => {
    const app = createApp({ modules: [ordinary()] });
    const server = await app.listen(0);
    servers.push(server);

    expect(await viaNodeUpgrade((server.address() as AddressInfo).port, '/__mesh__/control')).toEqual({
      status: 101,
      close: { code: 1008, reason: REASON },
    });
  });

  it('T4: a teapot with no exports (mesh configured, no control channel) refuses the same way on Node', async () => {
    const app = createApp({ modules: [ordinary()], experimental: true, mesh: {} });
    const server = await app.listen(0);
    servers.push(server);

    expect(await viaNodeUpgrade((server.address() as AddressInfo).port, '/__mesh__/control')).toEqual({
      status: 101,
      close: { code: 1008, reason: REASON },
    });
  });

  it('T5: app.upgrade closes 1008 with the same reason', async () => {
    const app = createApp({ modules: [ordinary()] });
    expect(await viaAppUpgrade(app, '/__mesh__/control')).toEqual({
      sent: [],
      closes: [{ code: 1008, reason: REASON }],
    });
  });
});

describe('CARD-21 T7: a teapot that advertises a route on the reserved path', () => {
  let wss: WebSocketServer | undefined;

  afterEach(() => wss?.close());

  /** A hand-rolled teapot: a real one refuses such a route at its own boot, so only the wire can carry it. */
  function foreignTeapot(pattern: string): string {
    wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const frame = decode(data.toString());
        if (frame.type === 'hello') {
          ws.send(
            encode({
              type: 'manifest',
              v: MESH_PROTOCOL_VERSION,
              steps: [],
              routes: [{ method: 'GET', pattern }],
            }),
          );
        }
      });
    });
    return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/__mesh__/control`;
  }

  it('the teacup splice fails and names the teapot', async () => {
    const url = foreignTeapot('/__mesh__/:x');
    const teacup = createApp({
      modules: [moduleWith([[Get, '/ok']])],
      experimental: true,
      mesh: { teapots: [{ url, secret: 's' }] },
    });

    try {
      await expect(teacup.ready()).rejects.toThrow(
        `mesh: remote route 'GET /__mesh__/:x' from ${url} uses the reserved path /__mesh__/control ` +
          '(the mesh control channel)',
      );
    } finally {
      await teacup.close();
    }
  });
});
