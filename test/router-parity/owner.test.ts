/**
 * Owner-requested additions (CARD-08 review) that need a running app: cross-pattern `Allow` through
 * both adapters, and the HTTP route table across a mesh peer's lifetime.
 */
import 'reflect-metadata';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { describe, it, afterAll, beforeAll } from 'vitest';
import { createApp, Route, Get, Post, Module } from '../../src/index';
import { ALLOW_REQUESTS, CrossAllowModule, fetchRequest, stableHeaders, type Seen } from './app-fixture';
import type { App } from '../../src/app/types';
import type { Logger } from '../../src/logger';
import { frozen, expectFrozenEqual } from './frozen';

function nodeRequest(port: number, method: string, path: string): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () =>
        resolve({ method, path, status: res.statusCode ?? 0, allow: (res.headers.allow as string) ?? null, body }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

// ── mesh: the HTTP route table across a peer's lifetime ─────────────────────────────────────────

const SECRET = 'parity-secret';

@Route('/remote')
class RemoteCtl {
  @Get('/ping', { export: true }) ping() {
    return { from: 'teapot' };
  }
}
@Module({ mountpoint: '/api', controllers: [RemoteCtl] })
class TeapotModule {}

@Route('/local')
class LocalCtl {
  @Get('/ok') ok() {
    return { from: 'teacup' };
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** A port nothing is listening on, that a teapot can take later. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// Same probes at every phase: the remote hit, its method miss, a local hit and a path miss.
const PROBES: Array<[string, string]> = [
  ['GET', '/api/remote/ping'],
  ['POST', '/api/remote/ping'],
  ['GET', '/api/local/ok'],
  ['GET', '/api/nope'],
];

async function probe(app: App, phase: string) {
  const out = [];
  for (const [method, path] of PROBES) {
    const { status, allow, body } = await fetchRequest(app, method, path);
    // The teapot's ephemeral port appears in the 503 body; the port is not routing behaviour.
    out.push({ phase, method, path, status, allow, body: body.replace(/ws:\/\/127\.0\.0\.1:\d+/g, '<teapot>') });
  }
  return out;
}

const teacupFor = (port: number) =>
  createApp({
    modules: [TeacupModule],
    experimental: true,
    logger: quiet,
    mesh: {
      teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: SECRET }],
      bootTimeoutMs: 300,
      timeoutMs: 500,
      reconnect: false,
    },
  });

/**
 * Two lifetimes. A: the teapot is up at boot, then goes away. B: the teapot is absent at boot and
 * comes up afterwards. The current code builds the HTTP table once, at boot, and never changes it:
 * routes spliced at boot stay in the table after their peer leaves, and a peer that arrives late
 * is never spliced in. CARD-10 can reuse this to assert the index is not rebuilt per request.
 */
async function meshLifetimes() {
  const results = [];

  const portA = await freePort();
  const teapotA = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  await teapotA.listen(portA);
  const teacupA = teacupFor(portA);
  try {
    results.push(...(await probe(teacupA, 'A1 teapot up at boot')));
    await teapotA.close();
    results.push(...(await probe(teacupA, 'A2 teapot gone after boot')));
  } finally {
    await teacupA.close();
  }

  const portB = await freePort();
  const teacupB = teacupFor(portB);
  const teapotB = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  try {
    results.push(...(await probe(teacupB, 'B1 teapot absent at boot')));
    await teapotB.listen(portB);
    results.push(...(await probe(teacupB, 'B2 teapot up after boot')));
  } finally {
    await teacupB.close();
    await teapotB.close();
  }

  return results;
}

// ── mesh: local and remote routes answering one path (CARD-07 indexes them as two trees) ─────────

@Route('/')
class RemoteMixCtl {
  // Same path as a local GET, another method.
  @Post('/dup/ping', { export: true }) dupPost() {
    return { from: 'teapot', route: 'POST /api/dup/ping' };
  }
  // A remote param route overlapping a local static one.
  @Post('/v/:id', { export: true }) vPost() {
    return { from: 'teapot', route: 'POST /api/v/:id' };
  }
  // Remote only: remote routes are `buffer`, so the teacup's router resolves HEAD to it implicitly.
  // Captured at ed47836 as HEAD → 404 (the teacup forwarded HEAD, and the teapot has no HEAD plan).
  // CARD-20 (#125, D16) changed that deliberately, with owner approval: the teacup forwards the
  // HEAD as a GET and drops the body, so HEAD now answers 200 like a local route.
  @Get('/x', { export: true }) x() {
    return { from: 'teapot', route: 'GET /api/x' };
  }
}
@Module({ mountpoint: '/api', controllers: [RemoteMixCtl] })
class RemoteMixTeapotModule {}

@Route('/')
class LocalMixCtl {
  @Get('/dup/ping') dupGet() {
    return { from: 'teacup', route: 'GET /api/dup/ping' };
  }
  @Get('/v/b') vGet() {
    return { from: 'teacup', route: 'GET /api/v/b' };
  }
}
@Module({ mountpoint: '/api', controllers: [LocalMixCtl] })
class LocalMixTeacupModule {}

const MIX_REQUESTS: Array<[string, string]> = [
  ...['PUT', 'OPTIONS', 'HEAD', 'GET', 'POST'].map((m): [string, string] => [m, '/api/dup/ping']),
  ...['PUT', 'OPTIONS', 'HEAD', 'GET', 'POST'].map((m): [string, string] => [m, '/api/v/b']),
  ...['PUT', 'OPTIONS', 'HEAD', 'GET'].map((m): [string, string] => [m, '/api/v/c']),
  ...['HEAD', 'GET', 'OPTIONS', 'PUT'].map((m): [string, string] => [m, '/api/x']),
];

/** Full stable headers for both adapters, so HEAD body suppression and content headers are visible. */
async function mixedTable() {
  const teapot = createApp({ modules: [RemoteMixTeapotModule], experimental: true, mesh: { secret: SECRET } });
  const tServer = await teapot.listen(0);
  const url = `ws://127.0.0.1:${(tServer.address() as AddressInfo).port}/__mesh__/control`;
  const teacup = createApp({
    modules: [LocalMixTeacupModule],
    experimental: true,
    logger: quiet,
    mesh: { teapots: [{ url, secret: SECRET }], reconnect: false },
  });

  try {
    const port = ((await teacup.listen(0)).address() as AddressInfo).port;
    const out = [];
    for (const [method, path] of MIX_REQUESTS) {
      const res = await teacup.fetch(new Request(`http://parity.test${path}`, { method }));
      out.push({
        adapter: 'fetch',
        method,
        path,
        status: res.status,
        headers: stableHeaders(res.headers),
        body: await res.text(),
      });
    }
    for (const [method, path] of MIX_REQUESTS) {
      const seen = await nodeRequestWithHeaders(port, method, path);
      out.push({ adapter: 'node', method, path, ...seen });
    }
    return out;
  } finally {
    await teacup.close();
    await teapot.close();
  }
}

function nodeRequestWithHeaders(port: number, method: string, path: string) {
  return new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        const headers = Object.entries(res.headers).map(([k, v]): [string, string] => [
          k,
          Array.isArray(v) ? v.join(', ') : String(v),
        ]);
        resolve({ status: res.statusCode ?? 0, headers: stableHeaders(headers), body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('router parity: owner-requested application cases', () => {
  let fetchApp: App;
  let nodeApp: App;
  let port: number;

  beforeAll(async () => {
    fetchApp = createApp({ modules: [CrossAllowModule] });
    nodeApp = createApp({ modules: [CrossAllowModule] });
    port = ((await nodeApp.listen(0)).address() as AddressInfo).port;
  });

  afterAll(() => nodeApp.close());

  it('cross-pattern Allow through app.fetch and Node equals the frozen capture', async () => {
    const run = async () => {
      const out: Array<Seen & { adapter: string }> = [];
      for (const [method, path] of ALLOW_REQUESTS)
        out.push({ adapter: 'fetch', ...(await fetchRequest(fetchApp, method, path)) });
      for (const [method, path] of ALLOW_REQUESTS)
        out.push({ adapter: 'node', ...(await nodeRequest(port, method, path)) });
      return out;
    };
    const expected = await frozen('owner-app-allow', run);
    expectFrozenEqual(await run(), expected, 'cross-pattern Allow');
  });

  it('the mesh HTTP route table across a peer lifetime equals the frozen capture', async () => {
    const expected = await frozen('owner-mesh-lifetime', meshLifetimes);
    expectFrozenEqual(await meshLifetimes(), expected, 'mesh lifetime');
  }, 30_000);

  it('local and remote routes on one path: Allow union, precedence and remote implicit HEAD equal the frozen capture', async () => {
    const expected = await frozen('owner-mesh-allow', mixedTable);
    expectFrozenEqual(await mixedTable(), expected, 'mesh local/remote mix');
  }, 30_000);
});
