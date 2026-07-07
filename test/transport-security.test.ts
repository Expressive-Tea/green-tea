import { describe, it, expect, afterEach } from 'vitest';
import https from 'https';
import WebSocket from 'ws';
import { createApp, Route, Get, Sse, Ws, Module, Transformer, inbound, channel, ctx } from '../src';
import { selfSignedTls } from './helpers/tls';

@Route('/')
class Api {
  @Get('/ping') ping() { return { ok: true }; }
  @Ws('/echo') echo(@inbound() msgs: AsyncIterable<unknown>) {
    const out = channel<unknown>();
    (async () => { for await (const m of msgs) out.push(m); })();
    return out;
  }
}

@Module({ mountpoint: '/', controllers: [Api] })
class ApiModule {}

let app: any;
afterEach(async () => { await app?.close(); });

describe('TLS', () => {
  it('serves https', async () => {
    app = createApp({ modules: [ApiModule], tls: selfSignedTls() });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const body = await new Promise<string>((resolve, reject) => {
      https.get({ port, path: '/ping', rejectUnauthorized: false }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
      }).on('error', reject);
    });
    expect(JSON.parse(body)).toEqual({ ok: true });
  });

  it('upgrades wss on the same server', async () => {
    app = createApp({ modules: [ApiModule], tls: selfSignedTls() });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const ws = new WebSocket(`wss://127.0.0.1:${port}/echo`, { rejectUnauthorized: false });
    const got = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (d) => resolve(d.toString()));
      ws.on('error', reject);
    });
    expect(got).toBe('hi');
    ws.close();
  });
});

describe('trustProxy', () => {
  it('trustProxy honors X-Forwarded-Proto; ctx exposes protocol/ip', async () => {
    @Route('/') class P { @Get('/who') who(@ctx() c: any) { return { proto: c.protocol, ip: c.ip }; } }
    @Module({ mountpoint: '/', controllers: [P] }) class PMod {}
    app = createApp({ modules: [PMod], trustProxy: true });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/who`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '9.9.9.9' } });
    expect(await r.json()).toEqual({ proto: 'https', ip: '9.9.9.9' });
  });
  it('without trustProxy, forwarded headers are ignored', async () => {
    @Route('/') class P { @Get('/who') who(@ctx() c: any) { return { proto: c.protocol }; } }
    @Module({ mountpoint: '/', controllers: [P] }) class PMod {}
    app = createApp({ modules: [PMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/who`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(await r.json()).toEqual({ proto: 'http' });
  });
});

describe('security headers', () => {
  it('on 200, 404, error; HSTS only when secure', async () => {
    @Route('/') class S {
      @Get('/ok') ok() { return { a: 1 }; }
      @Get('/boom') boom() { throw new Error('x'); }
    }
    @Module({ mountpoint: '/', controllers: [S] }) class SMod {}
    app = createApp({ modules: [SMod] }); // security defaults on
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const ok = await fetch(`http://127.0.0.1:${port}/ok`);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('strict-transport-security')).toBeNull(); // http, not secure
    const nf = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(nf.status).toBe(404);
    expect(nf.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    const boom = await fetch(`http://127.0.0.1:${port}/boom`);
    expect(boom.status).toBe(500);
    expect(boom.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('security:false emits none', async () => {
    @Route('/') class S { @Get('/ok') ok() { return { a: 1 }; } }
    @Module({ mountpoint: '/', controllers: [S] }) class SMod {}
    app = createApp({ modules: [SMod], security: false });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const ok = await fetch(`http://127.0.0.1:${port}/ok`);
    expect(ok.headers.get('x-content-type-options')).toBeNull();
  });

  it('HSTS present over https', async () => {
    @Route('/') class S { @Get('/ok') ok() { return { a: 1 }; } }
    @Module({ mountpoint: '/', controllers: [S] }) class SMod {}
    app = createApp({ modules: [SMod], tls: selfSignedTls() });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const hsts = await new Promise<string | undefined>((resolve, reject) => {
      https.get({ port, path: '/ok', rejectUnauthorized: false }, (res) => {
        res.resume();
        resolve(res.headers['strict-transport-security'] as string | undefined);
      }).on('error', reject);
    });
    expect(hsts).toContain('max-age=');
  });

  it('injected header wins over a case-variant handler header (no double line)', async () => {
    @Route('/') class S {
      @Get('/sneaky')
      @Transformer((v) => ({ status: 200, headers: { 'X-Content-Type-Options': 'SNIFF' }, body: JSON.stringify(v) }))
      sneaky() { return { a: 1 }; }
    }
    @Module({ mountpoint: '/', controllers: [S] }) class SMod {}
    app = createApp({ modules: [SMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/sneaky`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff'); // NOT 'SNIFF, nosniff'
  });

  it("preserves a handler's Title-Case Vary when no CORS is configured", async () => {
    @Route('/') class S {
      @Get('/vary')
      @Transformer((v) => ({ status: 200, headers: { Vary: 'Accept-Encoding' }, body: JSON.stringify(v) }))
      vary() { return { a: 1 }; }
    }
    @Module({ mountpoint: '/', controllers: [S] }) class SMod {}
    app = createApp({ modules: [SMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/vary`);
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('stream response carries security headers', async () => {
    @Route('/') class S {
      @Sse('/stream') async *stream() { yield 'a'; }
    }
    @Module({ mountpoint: '/', controllers: [S] }) class SMod {}
    app = createApp({ modules: [SMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/stream`, { headers: { accept: 'text/event-stream' } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    await res.body?.cancel();
  });
});

describe('CORS', () => {
  it('echoes allowed origin, sets Vary; preflight 204', async () => {
    @Route('/') class C { @Get('/x') x() { return { ok: 1 }; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod], cors: { origins: 'https://a.com' } });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/x`, { headers: { origin: 'https://a.com' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://a.com');
    expect(r.headers.get('vary')).toContain('Origin');
    const pre = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'OPTIONS', headers: { origin: 'https://a.com', 'access-control-request-method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('GET');
    expect(pre.headers.get('x-content-type-options')).toBe('nosniff'); // security headers on preflight too
  });

  it('credentials never returns *; echoes concrete origin', async () => {
    @Route('/') class C { @Get('/x') x() { return { ok: 1 }; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod], cors: { origins: '*', credentials: true } });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/x`, { headers: { origin: 'https://a.com' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://a.com');
    expect(r.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('disallowed origin → no allow-origin; bare OPTIONS (no ACRM) falls through to 404', async () => {
    @Route('/') class C { @Get('/x') x() { return { ok: 1 }; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod], cors: { origins: 'https://a.com' } });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/x`, { headers: { origin: 'https://evil.com' } });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    const bare = await fetch(`http://127.0.0.1:${port}/x`, { method: 'OPTIONS' }); // no ACRM
    expect(bare.status).toBe(404);
  });

  it("merges a handler's Title-Case Vary with CORS's Origin", async () => {
    @Route('/') class C {
      @Get('/x')
      @Transformer((v) => ({ status: 200, headers: { Vary: 'Accept-Encoding' }, body: JSON.stringify(v) }))
      x() { return { ok: 1 }; }
    }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod], cors: { origins: 'https://a.com' } });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/x`, { headers: { origin: 'https://a.com' } });
    const vary = r.headers.get('vary');
    expect(vary).toContain('Accept-Encoding');
    expect(vary).toContain('Origin');
  });
});
