import { describe, it, expect } from 'vitest';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../../src/index';

const SECRET = 's3cr3t';

@Provider({ provides: 'config', export: true })
class Config {
  provide() {
    return { config: { region: 'mx' } };
  }
}
@Step({ provides: 'auth', needs: [], export: true })
class Auth {
  run() {
    return { auth: { token: 'ok' } };
  }
}
@Route('/svc')
class SvcCtl {
  @Get('/ping', { export: true })
  ping() {
    return { pong: true };
  }
}
@Module({ mountpoint: '/api', providers: [Config], steps: [Auth], controllers: [SvcCtl] })
class TeapotModule {}

@Route('/local')
class LocalCtl {
  @Get('/who')
  who(@needs('auth') auth: any) {
    return { auth };
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

const controlUrl = (server: any) => `ws://127.0.0.1:${(server.address() as any).port}/__mesh__/control`;

/**
 * What a teacup answers once its teapot is gone. The status is the whole point: a dead upstream
 * is not "I broke" (500) — it is "my dependency is unavailable" (503), which is what tells an
 * operator where to look and what a caller may retry.
 */
describe('mesh link failure', () => {
  it('answers 503 on a remote step once the teapot is gone', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url: controlUrl(tServer), secret: SECRET }] },
    });

    const ok = await teacup.fetch(new Request('http://x/api/local/who'));
    expect(ok.status).toBe(200);

    await teapot.close();
    await new Promise((r) => setTimeout(r, 50));

    const down = await teacup.fetch(new Request('http://x/api/local/who'));
    expect(down.status).toBe(503);

    await teacup.close();
  });

  it('answers 503 on a proxied remote route once the teapot is gone', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url: controlUrl(tServer), secret: SECRET }] },
    });

    const ok = await teacup.fetch(new Request('http://x/api/svc/ping'));
    expect(ok.status).toBe(200);

    await teapot.close();
    await new Promise((r) => setTimeout(r, 50));

    const down = await teacup.fetch(new Request('http://x/api/svc/ping'));
    expect(down.status).toBe(503);

    await teacup.close();
  });

  it('keeps serving an app-scope remote from cache after the link drops', async () => {
    // Not a bug, but worth pinning: an app-scope export is resolved once and memoised, so it
    // survives its teapot — with a value that can go stale. Reconciling on reconnect is a
    // known gap (see the mesh guide), and this test is what would catch it changing by accident.
    @Route('/cached')
    class CachedCtl {
      @Get('/cfg')
      cfg(@needs('config') config: any) {
        return { config };
      }
    }
    @Module({ mountpoint: '/api', controllers: [CachedCtl] })
    class CachedModule {}

    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const teacup = createApp({
      modules: [CachedModule],
      experimental: true,
      mesh: { teapots: [{ url: controlUrl(tServer), secret: SECRET }] },
    });

    expect((await teacup.fetch(new Request('http://x/api/cached/cfg'))).status).toBe(200);

    await teapot.close();
    await new Promise((r) => setTimeout(r, 50));

    const after = await teacup.fetch(new Request('http://x/api/cached/cfg'));
    expect(after.status).toBe(200); // cached, so still answering
    expect(await after.json()).toEqual({ config: { region: 'mx' } });

    await teacup.close();
  });
});
