// Real Bun integration test for mesh: a teapot exporting its steps and a teacup consuming
// them, both under the actual Bun runtime, driven entirely through serveBun.
//
// Bun's ws lifecycle differs from Deno's — its socket events land on a server-level handler
// rather than the socket — so the control channel reaching app.upgrade here is a distinct
// path from the Deno test, not a duplicate of it.
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
    return { config: { region: 'mx', runtime: 'bun' } };
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

const controlUrl = (port: number) => `ws://127.0.0.1:${port}/__mesh__/control`;

test('mesh on Bun: teacup resolves a Bun teapot through the graph', async () => {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const tServer = await serveBun(teapot, { port: 0 });

  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    mesh: { teapots: [{ url: controlUrl(tServer.port), secret: SECRET }] },
  });
  const cServer = await serveBun(teacup, { port: 0 });

  try {
    const res = await fetch(`http://127.0.0.1:${cServer.port}/api/local/who`, { headers: { 'x-token': 'abc' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      config: { region: 'mx', runtime: 'bun' },
      auth: { token: 'abc' },
    });
  } finally {
    await teacup.close();
    cServer.stop(true);
    tServer.stop(true);
  }
});

test('mesh on Bun: a teapot refuses a bad secret over its control channel', async () => {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const tServer = await serveBun(teapot, { port: 0 });

  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    mesh: { teapots: [{ url: controlUrl(tServer.port), secret: 'WRONG' }], timeoutMs: 1000 },
  });

  try {
    await expect(teacup.fetch(new Request('http://x/api/local/who'))).rejects.toThrow(/mesh/);
  } finally {
    await teacup.close();
    tServer.stop(true);
  }
});

// CARD-18 T6 (GitHub #35, D9): a remote step whose token a local node already provides fails the
// splice, on Bun as on Node. Today that is the duplicate-name check in `setRunner`, which runs
// before the graph-wide one-producer check; this pins that the splice still refuses it.
@Step({ provides: 'auth', needs: [] })
class LocalAuth {
  run() {
    return { auth: { token: 'local' } };
  }
}
@Module({ mountpoint: '/api', steps: [LocalAuth], controllers: [LocalCtl] })
class ShadowingTeacupModule {}

test('mesh on Bun: a remote step colliding with a local token fails the splice', async () => {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const tServer = await serveBun(teapot, { port: 0 });

  const teacup = createApp({
    modules: [ShadowingTeacupModule],
    experimental: true,
    mesh: { teapots: [{ url: controlUrl(tServer.port), secret: SECRET }], timeoutMs: 1000 },
  });

  try {
    await expect(teacup.ready()).rejects.toThrow("duplicate provider/step name 'auth'");
  } finally {
    await teacup.close().catch(() => {});
    tServer.stop(true);
  }
});

// CARD-20 (#125, D16): HEAD on a remote GET answers like HEAD on a local one.
@Route('/remote')
class RemoteHeadCtl {
  @Get('/x', { export: true })
  x() {
    return { a: 1 };
  }
}
@Module({ mountpoint: '/api', controllers: [RemoteHeadCtl] })
class RemoteHeadTeapotModule {}
@Module({ mountpoint: '/api', controllers: [] })
class EmptyTeacupModule {}

test('mesh on Bun: HEAD on a remote GET answers 200 with the GET headers and no body', async () => {
  const teapot = createApp({ modules: [RemoteHeadTeapotModule], experimental: true, mesh: { secret: SECRET } });
  const tServer = await serveBun(teapot, { port: 0 });

  const teacup = createApp({
    modules: [EmptyTeacupModule],
    experimental: true,
    mesh: { teapots: [{ url: controlUrl(tServer.port), secret: SECRET }], reconnect: false },
  });
  const cServer = await serveBun(teacup, { port: 0 });

  try {
    const res = await fetch(`http://127.0.0.1:${cServer.port}/api/remote/x`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    expect(await res.text()).toBe('');
  } finally {
    await teacup.close();
    cServer.stop(true);
    tServer.stop(true);
  }
});
