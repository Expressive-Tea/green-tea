// Reconnection under the real Deno runtime.
//
// This exists separately from the Node suite because the teacup's WebSocket client is a different
// implementation here — Deno's global `WebSocket`, not the `ws` package — and a link that swaps its
// socket underneath a live graph is exactly the kind of thing that works on one and not the other.
//
// Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { createApp, Step, Route, Get, Module, needs } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

const SECRET = 's3cr3t';

@Step({ provides: 'config', needs: [], export: true })
class Config {
  run() {
    return { config: { runtime: 'deno' } };
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
  const probe = Deno.listen({ port: 0 });
  const { port } = probe.addr as Deno.NetAddr;
  probe.close();

  return port;
}

/** Boot a teapot on a fixed port; the returned handle can kill it and leave the port free again. */
async function startTeapot(port: number) {
  const app = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const server = await serveDeno(app, { port });
  await new Promise((r) => setTimeout(r, 50));

  return {
    stop: async () => {
      await server.shutdown();
      await app.close();
    },
  };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test('mesh on Deno: a teacup reconnects to a teapot that came back', async () => {
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
    assertEquals(before.status, 200);

    await teapot.stop();
    await settle(100);

    // the down window answers immediately rather than waiting out timeoutMs
    const down = await teacup.fetch(new Request('http://x/api/local/who'));
    assertEquals(down.status, 503);

    teapot = await startTeapot(port);
    await settle(400);

    const after = await teacup.fetch(new Request('http://x/api/local/who', { headers: { 'x-token': 'xyz' } }));
    assertEquals(after.status, 200);
    assertEquals((await after.json()).auth, { token: 'xyz' });
  } finally {
    await teacup.close();
    await teapot.stop();
  }
});

// CARD-19 (#124, D15): remote routes follow teapot membership on Deno too.
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
  const server = await serveDeno(app, { port });
  await new Promise((r) => setTimeout(r, 50));

  return {
    stop: async () => {
      await server.shutdown();
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
    await res.body?.cancel();
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

Deno.test('mesh on Deno: a teapot absent at boot has its routes served once it connects (CARD-19 T1)', async () => {
  const port = freePort();
  const teacup = pingTeacup(port);
  let teapot: Awaited<ReturnType<typeof startPingTeapot>> | undefined;

  try {
    const before = await teacup.fetch(new Request('http://x/api/remote/ping'));
    await before.body?.cancel();
    assertEquals(before.status, 404);

    teapot = await startPingTeapot(port);
    await untilStatus(teacup, '/api/remote/ping', 200);
  } finally {
    await teacup.close();
    await teapot?.stop();
  }
});

Deno.test('mesh on Deno: a reconnecting teapot keeps its routes with 503 + retry-after (CARD-19 T2)', async () => {
  const port = freePort();
  const teapot = await startPingTeapot(port);
  const teacup = pingTeacup(port);

  try {
    await untilStatus(teacup, '/api/remote/ping', 200);
    await teapot.stop();
    await untilStatus(teacup, '/api/remote/ping', 503);

    const down = await teacup.fetch(new Request('http://x/api/remote/ping'));
    await down.body?.cancel();
    assertEquals(down.status, 503);
    assertEquals(Number(down.headers.get('retry-after')) >= 1, true);

    const options = await teacup.fetch(new Request('http://x/api/remote/ping', { method: 'OPTIONS' }));
    assertEquals(options.headers.get('allow'), 'GET, HEAD, OPTIONS');
  } finally {
    await teacup.close();
  }
});
