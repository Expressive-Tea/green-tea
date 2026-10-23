/**
 * CARD-20 (#125, D16): `HEAD` on a remote buffered `GET` behaves like `HEAD` on a local one.
 *
 * The teacup resolves `HEAD` to the remote `GET` (implicit HEAD) and forwards it to the teapot as a
 * `GET`, then drops the body. The teapot is unchanged, so an older teapot works too.
 */
import 'reflect-metadata';
import http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, Route, Get, Head, Module, NotFound, ctx } from '../../src/index';
import type { App } from '../../src/app/types';
import type { Logger } from '../../src/logger';

const SECRET = 'head-secret';
const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const seen: string[] = [];

@Route('/')
class RemoteCtl {
  @Get('/x', { export: true }) x(@ctx() c: { req: { method: string } }) {
    seen.push(`x ${c.req.method}`);
    return { a: 1 };
  }
  @Get('/missing', { export: true }) missing() {
    seen.push('missing');
    throw new NotFound();
  }
  @Get('/boom', { export: true }) boom() {
    seen.push('boom');
    throw new Error('kaboom');
  }
  @Get('/both', { export: true }) bothGet() {
    seen.push('both GET');
    return { via: 'get' };
  }
  @Head('/both', { export: true }) bothHead(@ctx() c: { req: { method: string } }) {
    seen.push(`both HEAD as ${c.req.method}`);
    return { via: 'head' };
  }
}
@Module({ mountpoint: '/api', controllers: [RemoteCtl] })
class TeapotModule {}

@Module({ mountpoint: '/api', controllers: [] })
class TeacupModule {}

const open: App[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  seen.length = 0;
});

async function mesh(): Promise<{ teacup: App; port: number }> {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, logger: quiet, mesh: { secret: SECRET } });
  open.push(teapot);
  const tPort = ((await teapot.listen(0)).address() as AddressInfo).port;
  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    logger: quiet,
    mesh: { teapots: [{ url: `ws://127.0.0.1:${tPort}/__mesh__/control`, secret: SECRET }], reconnect: false },
  });
  open.unshift(teacup); // closed first
  const port = ((await teacup.listen(0)).address() as AddressInfo).port;
  return { teacup, port };
}

function nodeRequest(port: number, method: string, path: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const fetchVia = (app: App, method: string, path: string) =>
  app.fetch(new Request(`http://mesh.test${path}`, { method }));

describe('mesh: HEAD on a remote GET route (CARD-20, D16)', () => {
  it('T1: HEAD via app.fetch answers 200 with the GET headers and no body', async () => {
    const { teacup } = await mesh();
    const get = await fetchVia(teacup, 'GET', '/api/x');
    const head = await fetchVia(teacup, 'HEAD', '/api/x');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
    expect(head.headers.get('content-type')).toContain('application/json');
    expect(await head.text()).toBe('');
    expect(await get.json()).toEqual({ a: 1 });
  });

  it('T2: HEAD via the Node listener answers 200 with the GET headers and no body', async () => {
    const { port } = await mesh();
    const get = await nodeRequest(port, 'GET', '/api/x');
    const head = await nodeRequest(port, 'HEAD', '/api/x');
    expect(head.status).toBe(200);
    expect(head.headers['content-type']).toBe(get.headers['content-type']);
    expect(head.body).toBe('');
  });

  it('OPTIONS still advertises GET, HEAD, OPTIONS', async () => {
    const { teacup, port } = await mesh();
    expect((await fetchVia(teacup, 'OPTIONS', '/api/x')).headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect((await nodeRequest(port, 'OPTIONS', '/api/x')).headers.allow).toBe('GET, HEAD, OPTIONS');
  });

  it('T3: an explicit remote HEAD route keeps precedence over the implicit fallback', async () => {
    const { teacup, port } = await mesh();
    const viaFetch = await fetchVia(teacup, 'HEAD', '/api/both');
    expect(viaFetch.status).toBe(200);
    expect(await viaFetch.text()).toBe('');
    const viaNode = await nodeRequest(port, 'HEAD', '/api/both');
    expect(viaNode.status).toBe(200);
    expect(viaNode.body).toBe('');
    // The explicit HEAD handler ran, reached as HEAD — the GET handler never did.
    expect(seen).toEqual(['both HEAD as HEAD', 'both HEAD as HEAD']);
  });

  it('T4: a remote GET that throws NotFound answers HEAD with 404 and no body', async () => {
    const { teacup, port } = await mesh();
    const viaFetch = await fetchVia(teacup, 'HEAD', '/api/missing');
    expect(viaFetch.status).toBe(404);
    expect(await viaFetch.text()).toBe('');
    const viaNode = await nodeRequest(port, 'HEAD', '/api/missing');
    expect(viaNode.status).toBe(404);
    expect(viaNode.body).toBe('');
    // The teapot handler ran: the 404 is the route's, not a missing HEAD plan on the teapot.
    expect(seen).toEqual(['missing', 'missing']);
  });

  it('a remote GET that fails answers HEAD with 500 and no body', async () => {
    const { teacup, port } = await mesh();
    const viaFetch = await fetchVia(teacup, 'HEAD', '/api/boom');
    expect(viaFetch.status).toBe(500);
    expect(await viaFetch.text()).toBe('');
    const viaNode = await nodeRequest(port, 'HEAD', '/api/boom');
    expect(viaNode.status).toBe(500);
    expect(viaNode.body).toBe('');
  });

  it('T5: one HEAD calls the teapot handler once, as a GET', async () => {
    const { teacup } = await mesh();
    await fetchVia(teacup, 'HEAD', '/api/x');
    expect(seen).toEqual(['x GET']);
  });
});
