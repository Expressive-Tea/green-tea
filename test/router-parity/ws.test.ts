/**
 * WebSocket upgrade parity, kept apart from HTTP on purpose: WS selection is first-registered-wins
 * with no specificity ranking, an HTTP route at the same path never takes the upgrade, and the mesh
 * control path is checked before WS route matching. Captured through both upgrade entry points —
 * `app.upgrade` (Deno/Bun/edge) and the Node `server.on('upgrade')` listener — because they are
 * separate code paths. They used to disagree on the reserved mesh path; since CARD-21 (D17) both refuse
 * it with the same 1008 close.
 */
import 'reflect-metadata';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { describe, it, beforeAll, afterAll } from 'vitest';
import { createApp, Route, Get, Post, Ws, Stream, Module, param } from '../../src/index';
import { channel } from '../../src/channel';
import type { App } from '../../src/app/types';
import type { WsRequest, WsSocket } from '../../src/http/ws-core';
import { frozen, expectFrozenEqual } from './frozen';

const announce = (id: string, params: Record<string, string>) =>
  (async function* () {
    yield { id, params };
  })();

@Route('/')
class ParityWs {
  // Registered before the static twin: WS does not rank, so this one answers /live/lobby.
  @Ws('/live/:room') liveRoom(@param() p: Record<string, string>) {
    return announce('liveRoom', p);
  }
  @Ws('/live/lobby') liveLobby(@param() p: Record<string, string>) {
    return announce('liveLobby', p);
  }
  // Same path as the WS routes, different method, so the boot accepts it; it must not take upgrades.
  @Post('/live/lobby') httpLobby() {
    return { id: 'httpLobby' };
  }
  @Get('/plain') plain() {
    return { id: 'plain' };
  }
  // `negotiate` routes are registered for both HTTP and WS.
  @Stream('/feed') feed() {
    return announce('feed', {});
  }
  // No route on the reserved mesh path: since CARD-21 (D17) the boot refuses one. The path stays in
  // UPGRADE_PATHS so both adapters' refusal on an app with no mesh is captured; they now agree.
}

@Module({ mountpoint: '/', controllers: [ParityWs] })
class ParityWsModule {}

// The `ws` client runs its URL through the URL parser, so on the Node rows dot segments are already
// resolved before the server sees them; `app.upgrade` receives each path exactly as written here.
const UPGRADE_PATHS = [
  '/live/lobby',
  '/live/kitchen',
  '/live/lobby/',
  '/live/x/../lobby',
  '/live/a%20b',
  '/live/lobby?x=1',
  '/live/%E0%A4%A',
  '/live//lobby',
  '/plain',
  '/nope',
  '/feed',
  '/__mesh__/control',
];

const HTTP_REQUESTS: Array<[string, string]> = [
  ['GET', '/live/lobby'],
  ['POST', '/live/lobby'],
  ['OPTIONS', '/live/lobby'],
  ['GET', '/live/kitchen'],
  ['GET', '/feed'],
];

interface UpgradeOutcome {
  path: string;
  sent: unknown[];
  closes: Array<{ code?: number; reason?: string }>;
}

async function viaAppUpgrade(app: App, path: string): Promise<UpgradeOutcome> {
  const inbound = channel<unknown>();
  const ac = new AbortController();
  const sent: unknown[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  let open = true;
  const socket: WsSocket = {
    inbound,
    abort: ac.signal,
    get isOpen() {
      return open;
    },
    send: (data) => sent.push(JSON.parse(data)),
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
  return { path, sent, closes };
}

interface NodeUpgradeOutcome {
  path: string;
  status?: number;
  sent: unknown[];
  close?: { code: number; reason: string };
}

function viaNodeUpgrade(port: number, path: string): Promise<NodeUpgradeOutcome> {
  return new Promise((resolve) => {
    const sent: unknown[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    client.on('unexpected-response', (_req, res) => {
      resolve({ path, status: res.statusCode, sent });
      res.resume();
      client.terminate();
    });
    client.on('message', (data) => sent.push(JSON.parse(String(data))));
    client.on('close', (code, reason) => resolve({ path, status: 101, sent, close: { code, reason: String(reason) } }));
    client.on('error', () => {
      /* reported through unexpected-response or close */
    });
  });
}

describe('router parity: WebSocket upgrade outcomes', () => {
  let app: App;
  let nodeApp: App;
  let port: number;

  beforeAll(async () => {
    app = createApp({ modules: [ParityWsModule] });
    nodeApp = createApp({ modules: [ParityWsModule] });
    const server = await nodeApp.listen(0);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await nodeApp.close();
  });

  it('app.upgrade outcomes equal the frozen capture', async () => {
    const run = async () => {
      const out: UpgradeOutcome[] = [];
      for (const path of UPGRADE_PATHS) out.push(await viaAppUpgrade(app, path));
      return out;
    };
    const expected = await frozen('ws-app-upgrade', run);
    expectFrozenEqual(await run(), expected, 'app.upgrade');
  });

  it('Node upgrade listener outcomes equal the frozen capture', async () => {
    const run = async () => {
      const out: NodeUpgradeOutcome[] = [];
      for (const path of UPGRADE_PATHS) out.push(await viaNodeUpgrade(port, path));
      return out;
    };
    const expected = await frozen('ws-node-upgrade', run);
    expectFrozenEqual(await run(), expected, 'node upgrade');
  });

  it('plain HTTP requests at the WS paths equal the frozen capture', async () => {
    const run = async () => {
      const out: Array<{ method: string; path: string; status: number; allow: string | null; body: string }> = [];
      for (const [method, path] of HTTP_REQUESTS) {
        const res = await app.fetch(new Request(`http://parity.test${path}`, { method }));
        out.push({ method, path, status: res.status, allow: res.headers.get('allow'), body: await res.text() });
      }
      return out;
    };
    const expected = await frozen('ws-http-same-path', run);
    expectFrozenEqual(await run(), expected, 'http at ws paths');
  });
});
