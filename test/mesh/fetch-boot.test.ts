import { describe, it, expect } from 'vitest';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../../src/index';
import { channel } from '../../src/channel';
import { encode, decode, MESH_PROTOCOL_VERSION } from '../../src/mesh/protocol';
import type { WsSocket, WsRequest } from '../../src/http/ws-core';

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

@Route('/plain')
class PlainCtl {
  @Get('/ok')
  ok() {
    return { ok: true };
  }
}
@Module({ mountpoint: '/', controllers: [PlainCtl] })
class PlainModule {}

const teapotUrl = (port: number) => `ws://127.0.0.1:${port}/__mesh__/control`;

/** A neutral socket, exactly what serveDeno/serveBun hand to app.upgrade. */
const fakePeer = () => {
  const inbound = channel<unknown>();
  const ac = new AbortController();
  const sent: any[] = [];
  const closed: { code?: number; reason?: string }[] = [];
  const socket: WsSocket = {
    inbound,
    abort: ac.signal,
    isOpen: true,
    send: (data: string) => {
      sent.push(decode(data));
    },
    close: (code, reason) => {
      closed.push({ code, reason });
      inbound.close();
      ac.abort();
    },
    terminate: () => ac.abort(),
  };
  return { socket, sent, closed, inbound };
};

const controlReq = (): WsRequest => ({ url: '/__mesh__/control', headers: {}, protocol: 'http', ip: '' });

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

  it('closes the teapot links, even with no server to hang the close off', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = teapotUrl((tServer.address() as any).port);

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });
    const disconnects: string[] = [];
    teacup.bus.on('mesh:disconnect', (p) => disconnects.push(p.name));

    await teacup.fetch(new Request('http://x/api/local/who'));
    expect(disconnects).toEqual([]);

    // listen() never ran, so there is no server whose 'close' could reap the links
    await teacup.close();
    await new Promise((r) => setTimeout(r, 50));

    expect(disconnects).toEqual([url]);
    tServer.close();
  });

  it('resolves the graph via ready() without serving a request', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = teapotUrl((tServer.address() as any).port);

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });

    // a mesh graph is not knowable without asking the teapots, so it throws until resolved
    expect(() => teacup.graph()).toThrow(/until a mesh app has booted/);

    await teacup.ready();

    expect(teacup.graph().nodes.some((n) => n.name === 'config')).toBe(true);
    expect(teacup.inspect('/api/local/who').map((l) => `${l.kind}:${l.name}`)).toContain('provider:config');
    expect(teacup.explain('/api/local/who')).toBeTruthy();

    await teacup.close();
    tServer.close();
  });

  it('ready() resolves the graph but does NOT boot providers', async () => {
    // the point of ready() over a full boot: a devtool asking for the graph must not run
    // provider factories and open their connections as a side effect
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = teapotUrl((tServer.address() as any).port);

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });
    const booted: string[] = [];
    teacup.bus.on('boot:provider:start', (p) => booted.push(p.name));

    await teacup.ready();
    expect(teacup.graph().nodes.length).toBeGreaterThan(0); // graph is resolved
    expect(booted).toEqual([]); // and nothing was booted to get it

    await teacup.fetch(new Request('http://x/api/local/who'));
    expect(booted.length).toBeGreaterThan(0); // serving does boot them

    await teacup.close();
    tServer.close();
  });

  it('ready() is memoized and shared with the boot: a later fetch does not re-splice', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const tServer = await teapot.listen(0);
    const url = teapotUrl((tServer.address() as any).port);

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url, secret: SECRET }] },
    });
    let connects = 0;
    teacup.bus.on('mesh:connect', () => {
      connects += 1;
    });

    await Promise.all([teacup.ready(), teacup.ready()]);
    await teacup.fetch(new Request('http://x/api/local/who'));
    await teacup.ready();

    expect(connects).toBe(1);

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

/**
 * A teapot *exporting* over app.upgrade — the path serveDeno/serveBun drive. Without this the
 * control channel only existed on Node's server.on('upgrade'), so a teapot could not run off Node
 * and "mesh on 3 runtimes" would have meant consuming only.
 */
describe('mesh control over app.upgrade (no listen)', () => {
  it('serves the handshake to a peer that never touched a Node server', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const peer = fakePeer();

    void teapot.upgrade(controlReq(), peer.socket);
    peer.inbound.push(encode({ type: 'hello', v: MESH_PROTOCOL_VERSION, secret: SECRET }));
    await new Promise((r) => setTimeout(r, 20));

    expect(peer.sent[0]).toMatchObject({
      type: 'manifest',
      v: MESH_PROTOCOL_VERSION,
      scopes: expect.arrayContaining([{ token: 'config', scope: 'app' }]),
    });
    await teapot.close();
  });

  it('rejects a bad secret over app.upgrade too', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const peer = fakePeer();

    void teapot.upgrade(controlReq(), peer.socket);
    peer.inbound.push(encode({ type: 'hello', v: MESH_PROTOCOL_VERSION, secret: 'WRONG' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(peer.sent).toEqual([]);
    expect(peer.closed[0].code).toBe(1008);
    await teapot.close();
  });

  it('refuses the reserved path explicitly on an app that exports nothing', async () => {
    // a plain, self-contained app: the path is reserved regardless, so say so rather than
    // let it fall through to the generic "no matching ws route"
    const plain = createApp({ modules: [PlainModule] });
    const peer = fakePeer();

    await plain.upgrade(controlReq(), peer.socket);

    expect(peer.closed[0].code).toBe(1008);
    expect(peer.closed[0].reason).toMatch(/mesh control channel not enabled/i);
  });
});
