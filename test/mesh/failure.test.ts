import { describe, it, expect } from 'vitest';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../../src/index';

const SECRET = 's3cr3t';

@Step({ provides: 'config', needs: [], export: true })
class Config {
  run() {
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
@Module({ mountpoint: '/api', steps: [Config, Auth], controllers: [SvcCtl] })
class TeapotModule {}

/** A step slow enough that the teapot can be killed while its RPC is still on the wire. */
@Step({ provides: 'slow', needs: [], export: true })
class Slow {
  async run() {
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    return { slow: { done: true } };
  }
}
@Route('/svc')
class SlowRouteCtl {
  @Get('/slow', { export: true })
  async slow() {
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    return { done: true };
  }
}
@Module({ mountpoint: '/api', steps: [Slow], controllers: [SlowRouteCtl] })
class SlowTeapotModule {}

@Route('/local')
class SlowCtl {
  @Get('/slow')
  slow(@needs('slow') slow: any) {
    return { slow };
  }
}
@Module({ mountpoint: '/api', controllers: [SlowCtl] })
class SlowTeacupModule {}

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

  // The tests above kill the teapot *between* requests, so the link is already down when the next
  // one arrives and `rpc` fails before it sends anything. These two kill it with the RPC in flight,
  // which is the case that can hang: the request is parked on a promise waiting for an `rpc-res`
  // frame that is never coming. `endSession` has to reject what was waiting, not just stop
  // accepting new work. The assertion is on 503 specifically rather than "not 200" — a 504 would
  // mean the per-RPC timeout caught it instead, which is a much slower and much worse answer.
  it('answers 503 when the teapot dies with a step RPC still in flight', async () => {
    const teapot = createApp({ modules: [SlowTeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const teacup = createApp({
      modules: [SlowTeacupModule],
      experimental: true,
      mesh: { teapots: [{ url: controlUrl(tServer), secret: SECRET }] },
    });

    await teacup.ready();
    const inFlight = teacup.fetch(new Request('http://x/api/local/slow'));
    await new Promise((r) => setTimeout(r, 100)); // let the rpc-req reach the teapot
    await teapot.close();

    const res = await inFlight;

    expect(res.status).toBe(503);
    await teacup.close();
  }, 10_000);

  it('answers 503 when the teapot dies with a proxied route RPC still in flight', async () => {
    const teapot = createApp({ modules: [SlowTeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const teacup = createApp({
      modules: [SlowTeacupModule],
      experimental: true,
      mesh: { teapots: [{ url: controlUrl(tServer), secret: SECRET }] },
    });

    await teacup.ready();
    const inFlight = teacup.fetch(new Request('http://x/api/svc/slow'));
    await new Promise((r) => setTimeout(r, 100));
    await teapot.close();

    const res = await inFlight;

    expect(res.status).toBe(503);
    await teacup.close();
  }, 10_000);

  it('answers 503 on an exported step that used to be a cached app-scope provider', async () => {
    // Superseded by "forbid exporting a provider": `config` used to be an app-scope @Provider,
    // resolved once and memoised so it kept answering (stale) after the teapot died — a known gap
    // the old test pinned on purpose. A provider can no longer be exported at all, so `config` is
    // now a @Step like everything else on the wire: request-scope, re-run every time, and gone
    // the moment its teapot is. This is the same 503 as the other cases in this file, which is
    // the point — there is no more "cached" category left to special-case.
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
    expect(after.status).toBe(503);

    await teacup.close();
  });
});

describe('provider export', () => {
  it('refuses to boot when a provider is exported over the mesh', async () => {
    // `as any` is load-bearing, not laziness: `export` is not in `@Provider`'s options type, so a
    // TypeScript caller cannot write this at all. The cast is how the test reaches the runtime
    // backstop that a JavaScript caller would hit.
    @Provider({ provides: 'db', needs: [], export: true } as any)
    class Db {
      provide() {
        return { db: { query: () => [] } };
      }
    }
    @Module({ mountpoint: '/api', providers: [Db] })
    class AppModule {}

    // `experimental: true` so the boot reaches module/provider collection instead of stopping
    // at the earlier "mesh is an alpha feature" gate — this check is about the provider's own
    // declared metadata (`export: true` on a factory), not about whether mesh is wired up.
    expect(() => createApp({ modules: [AppModule], experimental: true, mesh: { secret: 's' } })).toThrow(
      /provider 'db' cannot be exported/i,
    );
  });
});
