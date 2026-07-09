import { describe, it, expect } from 'vitest';
import { createApp, Provider, Route, Get, Post, Module, needs, body } from '../src/index';

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

describe('app.fetch mesh gating (live `booted` read)', () => {
  it('throws before listen() and starts working after listen() finalizes', async () => {
    const meshApp = createApp({ modules: [MeshModule], experimental: true, mesh: { secret: 's3cr3t' } });

    await expect(meshApp.fetch(new Request('http://x/api/mesh/ping'))).rejects.toThrow(/unavailable before listen/);

    const server = await meshApp.listen(0);
    try {
      const res = await meshApp.fetch(new Request('http://x/api/mesh/ping'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pong: true });
    } finally {
      server.close();
    }
  });
});
