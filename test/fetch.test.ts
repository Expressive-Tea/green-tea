import { describe, it, expect } from 'vitest';
import { createApp, Provider, Route, Get, Post, Module, needs, body, ctx } from '../src/index';

@Provider({ provides: 'store' })
class Store {
  provide() {
    return { store: { hi: 'ok' } };
  }
}
@Route('/api')
class Ctl {
  @Get('/hello') hello(@needs('store') s: any) {
    return { store: s.hi };
  }
  @Post('/echo') echo(@body() b: any) {
    return { got: b };
  }
  @Post('/tiny', { maxBodyBytes: 10 }) tiny(@body() b: any) {
    return { got: b };
  }
}
@Module({ mountpoint: '/', providers: [Store], controllers: [Ctl] })
class M {}
const app = createApp({ modules: [M] });

@Route('/mesh')
class MeshCtl {
  @Get('/ping') ping() {
    return { pong: true };
  }
}
@Module({ mountpoint: '/api', controllers: [MeshCtl] })
class MeshModule {}

describe('app.fetch', () => {
  it('handles GET and returns JSON 200', async () => {
    const res = await app.fetch(new Request('http://x/api/hello'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ store: 'ok' });
  });
  it('parses a POST body', async () => {
    const res = await app.fetch(
      new Request('http://x/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      }),
    );
    expect(await res.json()).toEqual({ got: { a: 1 } });
  });
  it('404s an unknown route', async () => {
    const res = await app.fetch(new Request('http://x/nope'));
    expect(res.status).toBe(404);
  });
  it('sets secure-by-default headers', async () => {
    const res = await app.fetch(new Request('http://x/api/hello'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a 413 (oversized body) still carries the injected security headers', async () => {
    const res = await app.fetch(
      new Request('http://x/api/tiny', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 'well over ten bytes' }),
      }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('a 400 (invalid JSON) still carries the injected security headers', async () => {
    const res = await app.fetch(
      new Request('http://x/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

@Route('/ip')
class IpCtl {
  @Get('/whoami') whoami(@ctx() c: any) {
    return { ip: c.ip };
  }
}
@Module({ mountpoint: '/', controllers: [IpCtl] })
class IpModule {}

describe('app.fetch trustProxy gates x-forwarded-for', () => {
  it('honors x-forwarded-for (first hop) when trustProxy is true', async () => {
    const trustingApp = createApp({ modules: [IpModule], trustProxy: true });
    const res = await trustingApp.fetch(
      new Request('http://x/ip/whoami', { headers: { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' } }),
    );
    expect(await res.json()).toEqual({ ip: '9.9.9.9' });
  });

  it('ignores x-forwarded-for when trustProxy is off (default)', async () => {
    const untrustingApp = createApp({ modules: [IpModule] });
    const res = await untrustingApp.fetch(
      new Request('http://x/ip/whoami', { headers: { 'x-forwarded-for': '9.9.9.9, 1.1.1.1' } }),
    );
    expect(await res.json()).toEqual({ ip: '' });
  });
});

describe('app.fetch on a mesh app', () => {
  // Previously this asserted fetch() *threw* until listen() ran, which made mesh Node-only:
  // Deno/Bun/edge serve through app.fetch and can never call listen() (it builds an http.Server).
  // The boot gate now finalizes the mesh graph on first use, whoever triggers it.
  it('serves without ever calling listen()', async () => {
    const meshApp = createApp({ modules: [MeshModule], experimental: true, mesh: { secret: 's3cr3t' } });

    const res = await meshApp.fetch(new Request('http://x/api/mesh/ping'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
    await meshApp.close();
  });

  it('does not re-boot when listen() follows a fetch', async () => {
    const meshApp = createApp({ modules: [MeshModule], experimental: true, mesh: { secret: 's3cr3t' } });
    let booted = 0;
    meshApp.bus.on('boot:provider:start', () => {
      booted += 1;
    });

    await meshApp.fetch(new Request('http://x/api/mesh/ping'));
    const bootsAfterFetch = booted;
    const server = await meshApp.listen(0);

    try {
      const res = await meshApp.fetch(new Request('http://x/api/mesh/ping'));
      expect(res.status).toBe(200);
      // listen() shares fetch's memoized gate: provider factories must not run twice
      expect(booted).toBe(bootsAfterFetch);
    } finally {
      server.close();
    }
  });
});
