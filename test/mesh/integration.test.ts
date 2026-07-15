import { describe, it, expect, vi } from 'vitest';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../../src/index';

const SECRET = 's3cr3t';

@Provider({ provides: 'config', export: true })
class Config { provide() { return { config: { region: 'mx' } }; } }

@Step({ provides: 'auth', needs: [], export: true })
class Auth { run(ctx: any) { return { auth: { token: ctx.headers?.['x-token'] ?? 'anon' } }; } }

@Route('/remote')
class RemoteCtl { @Get('/ping', { export: true }) ping() { return { pong: true }; } }

@Module({ mountpoint: '/api', providers: [Config], steps: [Auth], controllers: [RemoteCtl] })
class TeapotModule {}

@Route('/local')
class LocalCtl {
  @Get('/who')
  who(@needs('config') config: any, @needs('auth') auth: any) { return { config, auth }; }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

// Two teapots exporting the SAME route and no scopes — a scope clash would throw first
// (setRunner enforces unique tokens), which would hide the route clash under test.
@Route('/dup')
class DupCtl {
  @Get('/ping', { export: true })
  ping() {
    return { pong: true };
  }
}
@Module({ mountpoint: '/api', controllers: [DupCtl] })
class DupTeapotModule {}

@Route('/c')
class PlainCtl {
  @Get('/ok')
  ok() {
    return { ok: true };
  }
}
@Module({ mountpoint: '/', controllers: [PlainCtl] })
class PlainTeacupModule {}

// A teacup declaring a route locally at the same path a teapot exports it.
@Route('/dup')
class ShadowCtl {
  @Get('/ping')
  ping() {
    return { from: 'local' };
  }
}
@Module({ mountpoint: '/api', controllers: [ShadowCtl] })
class ShadowTeacupModule {}

describe('mesh skeleton integration', () => {
  it('teacup resolves remote app-scope + request-scope into a local handler', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const tPort = (tServer.address() as any).port;
    const url = `ws://127.0.0.1:${tPort}/__mesh__/control`;

    const teacup = createApp({ modules: [TeacupModule], experimental: true, mesh: { teapots: [{ url, secret: SECRET }] } });
    const cServer = await teacup.listen(0);
    const cPort = (cServer.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${cPort}/api/local/who`, { headers: { 'x-token': 'abc' } });
    expect(await res.json()).toEqual({ config: { region: 'mx' }, auth: { token: 'abc' } });

    tServer.close(); cServer.close();
  });

  it('mesh is gated behind experimental: true', () => {
    expect(() => createApp({ modules: [TeapotModule], mesh: { secret: SECRET } })).toThrow(/alpha feature/);
  });

  it('teapot still serves its own local route (regression)', async () => {
    const app = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const s = await app.listen(0); const p = (s.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${p}/api/remote/ping`);
    expect(await res.json()).toEqual({ pong: true });
    s.close();
  });

  it('refuses to boot when two teapots export the same route, naming both', async () => {
    // No load balancing exists yet, so picking one silently would be a wrong answer that
    // callers could come to depend on — and it would make adding LB later a breaking change.
    const a = createApp({ modules: [DupTeapotModule], experimental: true, mesh: { secret: SECRET } });
    const b = createApp({ modules: [DupTeapotModule], experimental: true, mesh: { secret: SECRET } });
    const aServer = await a.listen(0);
    const bServer = await b.listen(0);
    const url = (s: any) => `ws://127.0.0.1:${(s.address() as any).port}/__mesh__/control`;

    const teacup = createApp({
      modules: [PlainTeacupModule],
      experimental: true,
      mesh: {
        teapots: [
          { url: url(aServer), secret: SECRET },
          { url: url(bServer), secret: SECRET },
        ],
      },
    });

    await expect(teacup.fetch(new Request('http://x/c/ok'))).rejects.toThrow(/GET \/api\/dup\/ping/);
    await expect(teacup.fetch(new Request('http://x/c/ok'))).rejects.toThrow(/load balancing/i);

    aServer.close();
    bServer.close();
  });

  it('accepts the same route from a single teapot (regression: no false positive)', async () => {
    const a = createApp({ modules: [DupTeapotModule], experimental: true, mesh: { secret: SECRET } });
    const aServer = await a.listen(0);
    const url = `ws://127.0.0.1:${(aServer.address() as any).port}/__mesh__/control`;

    const teacup = createApp({
      modules: [PlainTeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });

    const res = await teacup.fetch(new Request('http://x/api/dup/ping'));
    expect(await res.json()).toEqual({ pong: true });

    await teacup.close();
    aServer.close();
  });

  it('gives a local route precedence over a remote one, and says so', async () => {
    // Local-wins is the design: your own code beats an imported one, and it is how you
    // override a teapot. But it used to be an accident of [...local, ...remote] ordering
    // with nothing said, so a shadowed export looked like a broken teapot.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const teapot = createApp({ modules: [DupTeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = `ws://127.0.0.1:${(tServer.address() as any).port}/__mesh__/control`;

    const teacup = createApp({
      modules: [ShadowTeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });

    try {
      const res = await teacup.fetch(new Request('http://x/api/dup/ping'));
      expect(await res.json()).toEqual({ from: 'local' }); // local wins, not the teapot's {pong:true}

      const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(/GET \/api\/dup\/ping/);
      expect(warned).toMatch(/local/i);
      expect(warned).toContain(url); // which teapot got shadowed
    } finally {
      warn.mockRestore();
      await teacup.close();
      tServer.close();
    }
  });

  it('does not warn when a remote route has no local twin', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const teapot = createApp({ modules: [DupTeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = `ws://127.0.0.1:${(tServer.address() as any).port}/__mesh__/control`;

    const teacup = createApp({
      modules: [PlainTeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });

    try {
      await teacup.fetch(new Request('http://x/c/ok'));
      const shadowWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('precedence'));
      expect(shadowWarnings).toEqual([]);
    } finally {
      warn.mockRestore();
      await teacup.close();
      tServer.close();
    }
  });

  it('rejects a bad secret (teacup boot fails)', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0); const tPort = (tServer.address() as any).port;
    const teacup = createApp({ modules: [TeacupModule], experimental: true, mesh: { teapots: [{ url: `ws://127.0.0.1:${tPort}/__mesh__/control`, secret: 'WRONG' }], timeoutMs: 800 } });
    await expect(teacup.listen(0)).rejects.toThrow();
    tServer.close();
  });
});
