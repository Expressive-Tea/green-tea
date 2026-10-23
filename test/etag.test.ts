// CARD-15 (#114): weak ETags and conditional GET for static files (always, D12) and buffered handler
// responses (`createApp({ etag: true })`). Deno, Bun and edge repeat T1/T5 in their own suites.
import 'reflect-metadata';
import fs, { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createApp, Route, Get, Post, Sse, Module, Transformer, NotModified } from '../src/index';
import { ifNoneMatchMatches, bodyEtag, notModifiedSince } from '../src/http/conditional';

const root = mkdtempSync(join(tmpdir(), 'gt-etag-'));
const file = join(root, 'a.txt');
writeFileSync(file, 'hello static');
const mtime = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
utimesSync(file, mtime, mtime);

@Route('/h')
class Handlers {
  @Get('/json')
  json() {
    return { n: 1 };
  }

  @Get('/own')
  @Transformer(() => ({ headers: { 'content-type': 'text/plain', ETag: '"v7"' }, body: 'v7' }))
  own() {
    return null;
  }

  @Post('/post')
  post() {
    return { n: 1 };
  }

  @Sse('/sse')
  sse() {
    return (async function* () {
      yield 'x';
    })();
  }

  @Get('/skip')
  skip() {
    throw new NotModified();
  }
}

@Module({ mountpoint: '/', controllers: [Handlers] })
class M {}

const staticApp = createApp({ modules: [], static: root });
const etagApp = createApp({ modules: [M], etag: true });
const plainApp = createApp({ modules: [M] });
const req = (app: typeof staticApp, path: string, init: RequestInit = {}) =>
  app.fetch(new Request(`http://x${path}`, init));

afterEach(() => vi.restoreAllMocks());

describe('comparison (RFC 9110 §13.1.2)', () => {
  it('is weak, splits lists outside quotes, and honours *', () => {
    expect(ifNoneMatchMatches('W/"v7"', '"v7"')).toBe(true);
    expect(ifNoneMatchMatches('"v7"', 'W/"v7"')).toBe(true);
    expect(ifNoneMatchMatches('"a", W/"b", "c"', 'W/"b"')).toBe(true);
    expect(ifNoneMatchMatches('"a,b"', '"b"')).toBe(false);
    expect(ifNoneMatchMatches('"x", "a,b"', '"a,b"')).toBe(true);
    expect(ifNoneMatchMatches('*', '"anything"')).toBe(true);
    expect(ifNoneMatchMatches('"nope"', '"v7"')).toBe(false);
  });

  it('If-Modified-Since compares at one-second resolution and ignores a bad date', () => {
    expect(notModifiedSince(new Date(1000).toUTCString(), 1400)).toBe(true);
    expect(notModifiedSince(new Date(1000).toUTCString(), 2000)).toBe(false);
    expect(notModifiedSince('not a date', 0)).toBe(false);
  });

  it('a body tag is weak, deterministic and length-prefixed', () => {
    expect(bodyEtag('abc')).toBe(bodyEtag(Buffer.from('abc')));
    expect(bodyEtag('abc')).toMatch(/^W\/"3-[0-9a-z]+"$/);
    expect(bodyEtag('abc')).not.toBe(bodyEtag('abd'));
    expect(bodyEtag('é')).toMatch(/^W\/"2-/); // UTF-8 bytes, not UTF-16 units
  });
});

describe('static (D12: always on)', () => {
  it('T1: 200 with ETag + Last-Modified + no-cache, then 304 without reading the file', async () => {
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const first = await req(staticApp, '/a.txt');
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('hello static');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"12-[0-9a-z]+"$/);
    expect(first.headers.get('last-modified')).toBe(mtime.toUTCString());
    expect(first.headers.get('cache-control')).toBe('no-cache');

    const second = await req(staticApp, '/a.txt', { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('cache-control')).toBe('no-cache');
    expect(second.headers.get('last-modified')).toBe(mtime.toUTCString());
    expect(second.headers.get('content-type')).toBeNull();
    expect(second.headers.get('x-content-type-options')).toBe('nosniff');
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('T2: If-Modified-Since at or after mtime, no If-None-Match → 304', async () => {
    const res = await req(staticApp, '/a.txt', { headers: { 'if-modified-since': mtime.toUTCString() } });
    expect(res.status).toBe(304);
    const older = await req(staticApp, '/a.txt', {
      headers: { 'if-modified-since': new Date(mtime.getTime() - 5000).toUTCString() },
    });
    expect(older.status).toBe(200);
  });

  it('T3: If-None-Match wins over a matching If-Modified-Since', async () => {
    const res = await req(staticApp, '/a.txt', {
      headers: { 'if-none-match': '"other"', 'if-modified-since': mtime.toUTCString() },
    });
    expect(res.status).toBe(200);
  });

  it('T4: a touched file gets a new ETag and a 200', async () => {
    const touched = join(root, 'b.txt');
    writeFileSync(touched, 'b');
    utimesSync(touched, mtime, mtime);
    const before = (await req(staticApp, '/b.txt')).headers.get('etag')!;
    const later = new Date(mtime.getTime() + 60_000);
    utimesSync(touched, later, later);
    const res = await req(staticApp, '/b.txt', { headers: { 'if-none-match': before } });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).not.toBe(before);
  });

  it('HEAD with a matching tag is a 304 too, and never reads', async () => {
    const etag = (await req(staticApp, '/a.txt')).headers.get('etag')!;
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const res = await req(staticApp, '/a.txt', { method: 'HEAD', headers: { 'if-none-match': etag } });
    expect(res.status).toBe(304);
    const head = await req(staticApp, '/a.txt', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(etag);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('static: { dir, cacheControl } replaces no-cache on 200 and 304', async () => {
    const app = createApp({ modules: [], static: { dir: root, cacheControl: 'public, max-age=31536000, immutable' } });
    const res = await req(app, '/a.txt');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const nm = await req(app, '/a.txt', { headers: { 'if-none-match': res.headers.get('etag')! } });
    expect(nm.status).toBe(304);
    expect(nm.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('static object validation throws at createApp', () => {
    expect(() => createApp({ modules: [], static: { dir: root, cachecontrol: 'x' } as never })).toThrow(
      /unknown key 'cachecontrol'/,
    );
    expect(() => createApp({ modules: [], static: { cacheControl: 'no-cache\r\nX-Evil: 1' } })).toThrow(/CR or LF/);
    expect(() => createApp({ modules: [], static: { cacheControl: 5 as never } })).toThrow(/cacheControl/);
  });
});

describe('handlers (etag: true)', () => {
  it('T5: a buffered JSON GET twice → 304, empty body, same ETag', async () => {
    const first = await req(etagApp, '/h/json');
    const etag = first.headers.get('etag')!;
    expect(etag).toBe(bodyEtag(JSON.stringify({ n: 1 })));
    const second = await req(etagApp, '/h/json', { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('content-type')).toBeNull();
  });

  it('T6: a handler-set ETag is kept and drives the comparison', async () => {
    const first = await req(etagApp, '/h/own');
    expect(first.headers.get('etag')).toBe('"v7"');
    const res = await req(etagApp, '/h/own', { headers: { 'if-none-match': 'W/"v7"' } });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('"v7"');
  });

  it('T7/T8: a list containing the tag, and *', async () => {
    const etag = (await req(etagApp, '/h/json')).headers.get('etag')!;
    const list = await req(etagApp, '/h/json', { headers: { 'if-none-match': `"a", ${etag}, "c"` } });
    expect(list.status).toBe(304);
    const star = await req(etagApp, '/h/json', { headers: { 'if-none-match': '*' } });
    expect(star.status).toBe(304);
  });

  it('T9: POST, SSE and 404 get no ETag and no 304', async () => {
    const post = await req(etagApp, '/h/post', { method: 'POST', headers: { 'if-none-match': '*' } });
    expect(post.status).toBe(200);
    expect(post.headers.get('etag')).toBeNull();
    const sse = await req(etagApp, '/h/sse', { headers: { 'if-none-match': '*' } });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('etag')).toBeNull();
    await sse.body?.cancel();
    const missing = await req(etagApp, '/h/nope', { headers: { 'if-none-match': '*' } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('etag')).toBeNull();
  });

  it('T10: HEAD with a matching tag → 304; HEAD and GET carry the same tag', async () => {
    const etag = (await req(etagApp, '/h/json')).headers.get('etag')!;
    const head = await req(etagApp, '/h/json', { method: 'HEAD' });
    expect(head.headers.get('etag')).toBe(etag);
    const res = await req(etagApp, '/h/json', { method: 'HEAD', headers: { 'if-none-match': etag } });
    expect(res.status).toBe(304);
  });

  it('etag absent: no ETag on a handler response and no 304, even for a handler-set tag', async () => {
    const res = await req(plainApp, '/h/json', { headers: { 'if-none-match': '*' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeNull();
    const own = await req(plainApp, '/h/own', { headers: { 'if-none-match': '"v7"' } });
    expect(own.status).toBe(200);
  });

  it('NotModified still works, and its 304 has no body or content-type', async () => {
    for (const app of [plainApp, etagApp]) {
      const res = await req(app, '/h/skip');
      expect(res.status).toBe(304);
      expect(await res.text()).toBe('');
      expect(res.headers.get('content-type')).toBeNull();
    }
  });

  it('createApp({ etag }) accepts only a boolean', () => {
    expect(() => createApp({ modules: [], etag: 'yes' as never })).toThrow(/etag.*boolean/);
    expect(() => createApp({ modules: [], etag: false })).not.toThrow();
  });
});

describe('Node adapter (T11)', () => {
  const raw = (port: number, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path, headers }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        })
        .on('error', reject);
    });

  it('T1 and T5 over a real socket: 304s carry the tag and no body', async () => {
    const app = createApp({ modules: [M], etag: true, static: root });
    const server = await app.listen(0);
    const { port } = server.address() as AddressInfo;

    try {
      const readFile = vi.spyOn(fs.promises, 'readFile');
      const s1 = await raw(port, '/a.txt');
      const s2 = await raw(port, '/a.txt', { 'if-none-match': String(s1.headers.etag) });
      expect([s1.status, s2.status]).toEqual([200, 304]);
      expect(s2.body).toBe('');
      expect(s2.headers.etag).toBe(s1.headers.etag);
      expect(s2.headers['content-type']).toBeUndefined();
      expect(readFile).toHaveBeenCalledTimes(1);

      const h1 = await raw(port, '/h/json');
      const h2 = await raw(port, '/h/json', { 'if-none-match': String(h1.headers.etag) });
      expect([h1.status, h2.status]).toEqual([200, 304]);
      expect(h2.body).toBe('');
      expect(h2.headers['content-length']).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
