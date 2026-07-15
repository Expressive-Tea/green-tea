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

const teapotUrl = (port: number) => `ws://127.0.0.1:${port}/__mesh__/control`;

/**
 * A mesh teacup driven purely through `app.fetch` — the entry point Deno/Bun/edge use.
 * `listen()` is never called on the teacup, because on those runtimes it cannot be:
 * it builds a Node http.Server.
 */
describe('mesh over app.fetch (no listen)', () => {
  it('boots the mesh graph on the first request and resolves remote scopes', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = teapotUrl((tServer.address() as any).port);

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });

    const res = await teacup.fetch(new Request('http://x/api/local/who', { headers: { 'x-token': 'abc' } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ config: { region: 'mx' }, auth: { token: 'abc' } });

    await teacup.close();
    tServer.close();
  });

  it('boots exactly once across concurrent first requests', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = teapotUrl((tServer.address() as any).port);

    let connects = 0;
    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });
    teacup.bus.on('mesh:connect', () => {
      connects += 1;
    });

    const hit = () => teacup.fetch(new Request('http://x/api/local/who'));
    const all = await Promise.all([hit(), hit(), hit()]);

    expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(connects).toBe(1); // the boot gate is memoized: three racing requests splice once

    await teacup.close();
    tServer.close();
  });

  it('serves the remote scope in inspect() once a request has booted the graph', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = teapotUrl((tServer.address() as any).port);

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });

    await teacup.fetch(new Request('http://x/api/local/who'));
    const chain = teacup.inspect('/api/local/who').map((line) => `${line.kind}:${line.name}`);

    // the remote provider and step spliced into the local route's chain
    expect(chain).toContain('provider:config');
    expect(chain).toContain('step:auth');
    expect(teacup.graph().nodes.some((n) => n.name === 'config')).toBe(true);

    await teacup.close();
    tServer.close();
  });

  it('surfaces a failed mesh boot as a request error, not a silent success', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = teapotUrl((tServer.address() as any).port);

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: 'WRONG' }], timeoutMs: 800 },
    });

    await expect(teacup.fetch(new Request('http://x/api/local/who'))).rejects.toThrow();

    await teacup.close();
    tServer.close();
  });
});
