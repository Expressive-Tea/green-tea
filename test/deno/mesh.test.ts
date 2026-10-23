// Real Deno integration test for mesh: a teapot exporting its steps and a teacup consuming
// them, both under the actual Deno runtime, driven entirely through serveDeno.
//
// This is the test that makes "mesh runs off Node" a fact rather than an intention. It covers,
// in one round-trip, everything that used to be Node-only:
//   - the teacup's WebSocket client is Deno's global (no `ws` package here at all)
//   - the teapot's control channel is served via app.upgrade (Deno has no server.on('upgrade'))
//   - the graph boots on the first request; `listen()` is never called and cannot be
//   - node:crypto's timingSafeEqual + Buffer resolve under Deno's node-compat
//
// Run with: npm run test:deno
// `--no-check`: see the note in ws.test.ts — Deno type-checks the whole reachable graph,
// including Node-only modules this test never executes. tsc covers those.
import 'npm:reflect-metadata';
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { createApp, Step, Route, Get, Module, needs } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

const SECRET = 's3cr3t';

@Step({ provides: 'config', needs: [], export: true })
class Config {
  run() {
    return { config: { region: 'mx', runtime: 'deno' } };
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

/** Starts an app on Deno and resolves once its port is known. */
async function serve(app: ReturnType<typeof createApp>) {
  let port = 0;
  const server = await serveDeno(app, {
    port: 0,
    onListen: (addr) => {
      port = addr.port;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { server, port };
}

const controlUrl = (port: number) => `ws://127.0.0.1:${port}/__mesh__/control`;

Deno.test('mesh on Deno: teacup resolves a Deno teapot through the graph', async () => {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const t = await serve(teapot);

  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    mesh: { teapots: [{ url: controlUrl(t.port), secret: SECRET }] },
  });
  const c = await serve(teacup);

  try {
    const res = await fetch(`http://127.0.0.1:${c.port}/api/local/who`, { headers: { 'x-token': 'abc' } });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      config: { region: 'mx', runtime: 'deno' },
      auth: { token: 'abc' },
    });
  } finally {
    await teacup.close();
    await c.server.shutdown();
    await t.server.shutdown();
  }
});

Deno.test('mesh on Deno: a teapot refuses a bad secret over its control channel', async () => {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const t = await serve(teapot);

  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    mesh: { teapots: [{ url: controlUrl(t.port), secret: 'WRONG' }], timeoutMs: 1000 },
  });

  try {
    let message = '';
    try {
      await teacup.fetch(new Request('http://x/api/local/who'));
    } catch (err) {
      message = String((err as Error).message);
    }
    assertStringIncludes(message, 'mesh');
  } finally {
    await teacup.close();
    await t.server.shutdown();
  }
});

// CARD-18 T6 (GitHub #35, D9): a remote step whose token a local node already provides fails the
// splice, on Deno as on Node. Today that is the duplicate-name check in `setRunner`, which runs
// before the graph-wide one-producer check; this pins that the splice still refuses it.
@Step({ provides: 'auth', needs: [] })
class LocalAuth {
  run() {
    return { auth: { token: 'local' } };
  }
}
@Module({ mountpoint: '/api', steps: [LocalAuth], controllers: [LocalCtl] })
class ShadowingTeacupModule {}

Deno.test('mesh on Deno: a remote step colliding with a local token fails the splice', async () => {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const t = await serve(teapot);

  const teacup = createApp({
    modules: [ShadowingTeacupModule],
    experimental: true,
    mesh: { teapots: [{ url: controlUrl(t.port), secret: SECRET }], timeoutMs: 1000 },
  });

  try {
    let message = '';
    try {
      await teacup.ready();
    } catch (err) {
      message = String((err as Error).message);
    }
    assertStringIncludes(message, "duplicate provider/step name 'auth'");
  } finally {
    await teacup.close().catch(() => {});
    await t.server.shutdown();
  }
});
