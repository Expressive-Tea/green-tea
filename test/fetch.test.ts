import { describe, it, expect } from 'vitest';
import { createApp, Provider, Route, Get, Post, Module, needs, body, ctx } from '../src/index';
import { countingStream } from './helpers/counting-stream';

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

// #105: the limit is enforced while the body is read, not after it has been buffered. A status code
// cannot tell the two apart — both answer 413 — so the counting stream is what these assert on.
@Route('/limits')
class LimitsCtl {
  @Post('/echo') echo(@body() b: any) {
    return { got: b };
  }
  @Post('/small', { maxBodyBytes: 10 }) small(@body() b: any) {
    return { got: b };
  }
  @Post('/large', { maxBodyBytes: 2_000_000 }) large(@body() b: any) {
    return { length: String(b).length };
  }
}
@Module({ mountpoint: '/', controllers: [LimitsCtl] })
class LimitsModule {}

const post = (path: string, body: RequestInit['body'], headers: Record<string, string> = {}) =>
  new Request(`http://x${path}`, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

describe('app.fetch bounded body reads (#105)', () => {
  const limitsApp = createApp({ modules: [LimitsModule] }); // server limit: the 1 MB default

  it('T1: a declared content-length over the limit is refused without reading the body', async () => {
    const body = countingStream(10, 300_000);

    const res = await limitsApp.fetch(post('/limits/echo', body.stream, { 'content-length': '2000000' }));

    expect(res.status).toBe(413);
    expect(body.pulled).toBe(0);
    expect(body.cancelled).toBe(true);
  });

  it('T3: a streamed body stops at the chunk that crosses the limit, and the reader is cancelled', async () => {
    const body = countingStream(10, 300_000); // 3 MB, no content-length

    const res = await limitsApp.fetch(post('/limits/echo', body.stream));

    expect(res.status).toBe(413);
    // 4 read, the 4th crossing 1 MB, plus at most one the stream queued ahead of the reader.
    expect(body.pulled).toBeLessThanOrEqual(5);
    expect(body.cancelled).toBe(true);
  });

  it('T4: a body of exactly the limit is accepted', async () => {
    const json = JSON.stringify({ s: 'x'.repeat(1_000_000 - 8) });
    expect(Buffer.byteLength(json)).toBe(1_000_000);

    const res = await limitsApp.fetch(post('/limits/echo', json, { 'content-type': 'application/json' }));

    expect(res.status).toBe(200);
    expect(((await res.json()) as any).got.s).toHaveLength(1_000_000 - 8);
  });

  it('T5: one byte over the limit is refused', async () => {
    const json = JSON.stringify({ s: 'x'.repeat(1_000_000 - 7) });

    const res = await limitsApp.fetch(post('/limits/echo', json, { 'content-type': 'application/json' }));

    expect(res.status).toBe(413);
  });

  it('T5: one byte over the limit is refused when streamed without a content-length', async () => {
    const body = countingStream(1, 1_000_001);

    const res = await limitsApp.fetch(post('/limits/echo', body.stream));

    expect(res.status).toBe(413);
  });

  it('T8: a route limit below the server limit wins', async () => {
    const res = await limitsApp.fetch(post('/limits/small', 'x'.repeat(11), { 'content-type': 'text/plain' }));

    expect(res.status).toBe(413);
  });

  it('T9: a route limit above the server limit wins', async () => {
    const res = await limitsApp.fetch(
      post('/limits/large', 'x'.repeat(1_500_000), { 'content-type': 'text/plain' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: 1_500_000 });
  });

  it('a malformed content-length is ignored, and the stream count enforces the limit', async () => {
    const body = countingStream(1, 20);

    const res = await limitsApp.fetch(post('/limits/small', body.stream, { 'content-length': 'nope' }));

    expect(res.status).toBe(413);
  });

  it('T10: a bodiless request is answered without reading anything', async () => {
    const res = await limitsApp.fetch(new Request('http://x/limits/echo', { method: 'POST' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
