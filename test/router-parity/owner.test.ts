/**
 * Owner-requested additions (CARD-08 review) that need a running app: cross-pattern `Allow` through
 * both adapters, and the HTTP route table across a mesh peer's lifetime.
 */
import 'reflect-metadata';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { describe, it, afterAll, beforeAll } from 'vitest';
import { createApp, Route, Get, Post, Delete, Module, param } from '../../src/index';
import type { App } from '../../src/app/types';
import type { Logger } from '../../src/logger';
import { frozen, expectFrozenEqual } from './frozen';

// `/ca` is GET :id + POST b; `/cb` adds DELETE :rest*. Two prefixes because one app cannot hold both
// variants at the same path.
@Route('/')
class CrossAllow {
  @Get('/ca/:id') caGet(@param() p: Record<string, string>) {
    return { id: 'caGet', p };
  }
  @Post('/ca/b') caPost() {
    return { id: 'caPost' };
  }
  @Get('/cb/:id') cbGet(@param() p: Record<string, string>) {
    return { id: 'cbGet', p };
  }
  @Post('/cb/b') cbPost() {
    return { id: 'cbPost' };
  }
  @Delete('/cb/:rest*') cbDelete(@param() p: Record<string, string>) {
    return { id: 'cbDelete', p };
  }
}
@Module({ mountpoint: '/', controllers: [CrossAllow] })
class CrossAllowModule {}

const ALLOW_REQUESTS: Array<[string, string]> = ['/ca', '/cb'].flatMap((base): Array<[string, string]> => [
  ['PUT', `${base}/b`],
  ['OPTIONS', `${base}/b`],
  ['PUT', `${base}/x`],
  ['HEAD', `${base}/b`],
  ['PUT', `${base}/x/y`],
]);

interface Seen {
  method: string;
  path: string;
  status: number;
  allow: string | null;
  body: string;
}

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

async function fetchRequest(app: App, method: string, path: string): Promise<Seen> {
  const res = await app.fetch(new Request(`http://parity.test${path}`, { method }));
  return { method, path, status: res.status, allow: res.headers.get('allow'), body: await res.text() };
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
});
