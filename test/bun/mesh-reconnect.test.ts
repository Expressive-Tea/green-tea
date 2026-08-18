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
import { createApp, Provider, Step, Route, Get, Module, needs } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

const SECRET = 's3cr3t';

@Provider({ provides: 'config', export: true })
class Config {
  provide() {
    return { config: { runtime: 'bun' } };
  }
}
@Step({ provides: 'auth', needs: [], export: true })
class Auth {
  run(ctx: any) {
    return { auth: { token: ctx.headers?.['x-token'] ?? 'anon' } };
  }
}
@Module({ mountpoint: '/api', providers: [Config], steps: [Auth] })
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
function startTeapot(port: number) {
  const app = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const server = serveBun(app, { port });

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
  let teapot = startTeapot(port);

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

    teapot = startTeapot(port);
    await settle(400);

    const after = await teacup.fetch(new Request('http://x/api/local/who', { headers: { 'x-token': 'xyz' } }));
    expect(after.status).toBe(200);
    expect((await after.json()).auth).toEqual({ token: 'xyz' });
  } finally {
    await teacup.close();
    await teapot.stop();
  }
});
