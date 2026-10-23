// Reconnection under the real Bun runtime.
//
// Separate from the Node and Deno suites deliberately. Bun's WebSocket lifecycle is a third
// implementation — its socket events land on a server-level handler rather than the socket — and a
// link that swaps its socket underneath a live graph is precisely where three implementations
// stop behaving the same. Defining this on Node and hoping is not enough.
//
// Run with: npm run test:bun
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp, Step, Route, Get, Module, needs } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

const SECRET = 's3cr3t';

@Step({ provides: 'config', needs: [], export: true })
class Config {
  run() {
    return { config: { runtime: 'bun' } };
  }
}
@Step({ provides: 'auth', needs: [], export: true })
class Auth {
  run(ctx: any) {
    return { auth: { token: ctx.headers?.['x-token'] ?? 'anon' } };
  }
}
@Module({ mountpoint: '/api', steps: [Config, Auth] })
class TeapotModule {}

@Route('/local')
class LocalCtl {
  @Get('/who')
  who(@needs('config') config: any, @needs('auth') auth: any) {
    return { config, auth };
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

/** A port nobody is on, so the teapot can be killed and brought back at the same address. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = probe;
  probe.stop(true);

  return port;
}

/** Boot a teapot on a fixed port; the handle kills it and leaves the port free again. */
async function startTeapot(port: number) {
  const app = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const server = await serveBun(app, { port });

  return {
    stop: async () => {
      server.stop(true);
      await app.close();
    },
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('mesh on Bun: a teacup reconnects to a teapot that came back', async () => {
  const port = freePort();
  let teapot = await startTeapot(port);

  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    mesh: {
      teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: SECRET }],
      reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
      heartbeatMs: 50,
      timeoutMs: 2000,
    },
  });

  try {
    const before = await teacup.fetch(new Request('http://x/api/local/who', { headers: { 'x-token': 'abc' } }));
    expect(before.status).toBe(200);

    await teapot.stop();
    await settle(100);

    // the down window answers immediately rather than waiting out timeoutMs
    const down = await teacup.fetch(new Request('http://x/api/local/who'));
    expect(down.status).toBe(503);

    teapot = await startTeapot(port);
    await settle(400);

    const after = await teacup.fetch(new Request('http://x/api/local/who', { headers: { 'x-token': 'xyz' } }));
    expect(after.status).toBe(200);
    expect((await after.json()).auth).toEqual({ token: 'xyz' });
  } finally {
    await teacup.close();
    await teapot.stop();
  }
});

// CARD-19 (#124, D15): remote routes follow teapot membership on Bun too.
@Route('/remote')
class PingCtl {
  @Get('/ping', { export: true })
  ping() {
    return { from: 'teapot' };
  }
}
@Module({ mountpoint: '/api', controllers: [PingCtl] })
class PingTeapotModule {}
@Module({ mountpoint: '/api', controllers: [] })
class BareTeacupModule {}

async function startPingTeapot(port: number) {
  const app = createApp({ modules: [PingTeapotModule], experimental: true, mesh: { secret: SECRET } });
  const server = await serveBun(app, { port });

  return {
    stop: async () => {
      server.stop(true);
      await app.close();
    },
  };
}

/** Polls `GET path` until it answers `status`, or fails after `ms`. */
async function untilStatus(app: ReturnType<typeof createApp>, path: string, status: number, ms = 3000) {
  const deadline = Date.now() + ms;
  let last = 0;
  while (Date.now() < deadline) {
    const res = await app.fetch(new Request(`http://x${path}`));
    await res.text();
    last = res.status;
    if (last === status) return;
    await settle(25);
  }
  throw new Error(`${path} answered ${last}, expected ${status}`);
}

const pingTeacup = (port: number) =>
  createApp({
    modules: [BareTeacupModule],
    experimental: true,
    mesh: {
      teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: SECRET }],
      reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
      bootTimeoutMs: 100,
      heartbeatMs: 50,
      timeoutMs: 2000,
    },
  });

test('mesh on Bun: a teapot absent at boot has its routes served once it connects (CARD-19 T1)', async () => {
  const port = freePort();
  const teacup = pingTeacup(port);
  let teapot: Awaited<ReturnType<typeof startPingTeapot>> | undefined;

  try {
    expect((await teacup.fetch(new Request('http://x/api/remote/ping'))).status).toBe(404);
    teapot = await startPingTeapot(port);
    await untilStatus(teacup, '/api/remote/ping', 200);
  } finally {
    await teacup.close();
    await teapot?.stop();
  }
});

test('mesh on Bun: a reconnecting teapot keeps its routes with 503 + retry-after (CARD-19 T2)', async () => {
  const port = freePort();
  const teapot = await startPingTeapot(port);
  const teacup = pingTeacup(port);

  try {
    await untilStatus(teacup, '/api/remote/ping', 200);
    await teapot.stop();
    await untilStatus(teacup, '/api/remote/ping', 503);

    const down = await teacup.fetch(new Request('http://x/api/remote/ping'));
    expect(down.status).toBe(503);
    expect(Number(down.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    const options = await teacup.fetch(new Request('http://x/api/remote/ping', { method: 'OPTIONS' }));
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  } finally {
    await teacup.close();
  }
});
