// Reconnection under the real Deno runtime.
//
// This exists separately from the Node suite because the teacup's WebSocket client is a different
// implementation here — Deno's global `WebSocket`, not the `ws` package — and a link that swaps its
// socket underneath a live graph is exactly the kind of thing that works on one and not the other.
//
// Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

const SECRET = 's3cr3t';

@Provider({ provides: 'config', export: true })
class Config {
  provide() {
    return { config: { runtime: 'deno' } };
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
  const probe = Deno.listen({ port: 0 });
  const { port } = probe.addr as Deno.NetAddr;
  probe.close();

  return port;
}

/** Boot a teapot on a fixed port; the returned handle can kill it and leave the port free again. */
async function startTeapot(port: number) {
  const app = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const server = serveDeno(app, { port });
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
