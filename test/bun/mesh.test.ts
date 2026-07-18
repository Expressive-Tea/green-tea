// Real Bun integration test for mesh: a teapot exporting its scopes and a teacup consuming
// them, both under the actual Bun runtime, driven entirely through serveBun.
//
// Bun's ws lifecycle differs from Deno's — its socket events land on a server-level handler
// rather than the socket — so the control channel reaching app.upgrade here is a distinct
// path from the Deno test, not a duplicate of it.
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
    return { config: { region: 'mx', runtime: 'bun' } };
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

const controlUrl = (port: number) => `ws://127.0.0.1:${port}/__mesh__/control`;

test('mesh on Bun: teacup resolves a Bun teapot through the graph', async () => {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const tServer = serveBun(teapot, { port: 0 });

  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    mesh: { teapots: [{ url: controlUrl(tServer.port), secret: SECRET }] },
  });
  const cServer = serveBun(teacup, { port: 0 });

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
  const tServer = serveBun(teapot, { port: 0 });

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
