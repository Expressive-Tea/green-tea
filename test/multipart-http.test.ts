import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, Route, Post, Module, body } from '../src';

// Counts calls into the multipart parser while still running the real one, so a test can prove
// busboy was never reached rather than inferring it from the status code.
const parsed = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../src/multipart', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/multipart')>();
  return {
    ...real,
    parseMultipart: (...args: Parameters<typeof real.parseMultipart>) => {
      parsed.calls++;
      return real.parseMultipart(...args);
    },
  };
});

let app: any;
afterEach(async () => { await app?.close(); });

describe('multipart over http', () => {
  it('parses fields + a binary file round-trip', async () => {
    @Route('/') class C {
      @Post('/upload') up(@body() b: any) {
        const f = b.files.file;
        return { name: b.fields.name, filename: f.filename, bytes: [...f.data], type: f.contentType };
      }
    }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const fd = new FormData();
    fd.set('name', 'joe');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    fd.set('file', new Blob([bytes], { type: 'image/png' }), 'p.png');
    const r = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: fd });
    const out = (await r.json()) as any;
    expect(out.name).toBe('joe');
    expect(out.filename).toBe('p.png');
    expect(out.type).toBe('image/png');
    expect(out.bytes).toEqual([...bytes]);
  });

  it('text/plain body still arrives as a string (fallthrough preserved)', async () => {
    @Route('/') class C { @Post('/t') t(@body() b: any) { return { isString: typeof b === 'string', b }; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/t`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' });
    expect(await r.json()).toEqual({ isString: true, b: 'hello' });
  });

  it('malformed multipart → 400', async () => {
    @Route('/') class C { @Post('/u') u(@body() b: any) { return b; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/u`, {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=' }, body: 'x' });
    expect(r.status).toBe(400);
  });
});

describe('bodyDuplicates', () => {
  it('app "array" makes repeated urlencoded fields arrays', async () => {
    @Route('/') class C { @Post('/f') f(@body() b: any) { return b; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod], bodyDuplicates: 'array' });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/f`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1&x=2&y=9' });
    expect(await r.json()).toEqual({ x: ['1', '2'], y: ['9'] });
  });
  it('default (no option) keeps urlencoded last-wins', async () => {
    @Route('/') class C { @Post('/f') f(@body() b: any) { return b; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/f`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1&x=2' });
    expect(await r.json()).toEqual({ x: '2' });
  });

  it('per-endpoint override beats app default', async () => {
    @Route('/') class C {
      @Post('/a', { duplicates: 'last' }) a(@body() b: any) { return b; }
      @Post('/b', { duplicates: 'array' }) b2(@body() b: any) { return b; }
    }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod], bodyDuplicates: 'last' });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const post = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1&x=2' }).then((r) => r.json());
    expect(await post('/a')).toEqual({ x: '2' });
    expect(await post('/b')).toEqual({ x: ['1', '2'] });
  });
});

// #105: multipart is parsed from the bytes the bounded reader returns, so the byte limit has to stop
// a request before busboy ever sees it, and `maxParts` has to keep working on what gets through.
describe('multipart limits on app.fetch (#105)', () => {
  const form = (fields: number, size = 1) => {
    const fd = new FormData();
    for (let i = 0; i < fields; i++) fd.set(`f${i}`, 'x'.repeat(size));
    return fd;
  };

  it('T6: a multipart body over maxBodyBytes is 413 and never reaches the parser', async () => {
    @Route('/') class C { @Post('/u', { maxBodyBytes: 1000 }) u(@body() b: any) { return b; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod] });
    parsed.calls = 0;

    const r = await app.fetch(new Request('http://x/u', { method: 'POST', body: form(1, 5000) }));

    expect(r.status).toBe(413);
    expect(parsed.calls).toBe(0);
  });

  it('T6: the same holds when the multipart body arrives without a content-length', async () => {
    @Route('/') class C { @Post('/u', { maxBodyBytes: 1000 }) u(@body() b: any) { return b; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod] });
    parsed.calls = 0;
    const encoded = new Request('http://x', { method: 'POST', body: form(1, 5000) });

    const r = await app.fetch(new Request('http://x/u', {
      method: 'POST',
      headers: { 'content-type': encoded.headers.get('content-type')! },
      body: encoded.body,
      duplex: 'half',
    } as RequestInit));

    expect(r.status).toBe(413);
    expect(parsed.calls).toBe(0);
  });

  it('T7: under the byte limit but over maxParts is 400 Invalid multipart body', async () => {
    @Route('/') class C { @Post('/u', { maxParts: 2 }) u(@body() b: any) { return b; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod] });

    const r = await app.fetch(new Request('http://x/u', { method: 'POST', body: form(3) }));

    expect(r.status).toBe(400);
    expect(await r.text()).toContain('Invalid multipart body');
  });

  it('T7: the server-level maxParts applies when the route sets none', async () => {
    @Route('/') class C { @Post('/u') u(@body() b: any) { return b; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod], limits: { maxParts: 2 } });

    expect((await app.fetch(new Request('http://x/u', { method: 'POST', body: form(1) }))).status).toBe(200);
    expect((await app.fetch(new Request('http://x/u', { method: 'POST', body: form(3) }))).status).toBe(400);
  });
});
