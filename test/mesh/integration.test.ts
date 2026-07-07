import { describe, it, expect } from 'vitest';
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

  it('rejects a bad secret (teacup boot fails)', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0); const tPort = (tServer.address() as any).port;
    const teacup = createApp({ modules: [TeacupModule], experimental: true, mesh: { teapots: [{ url: `ws://127.0.0.1:${tPort}/__mesh__/control`, secret: 'WRONG' }], timeoutMs: 800 } });
    await expect(teacup.listen(0)).rejects.toThrow();
    tServer.close();
  });
});
