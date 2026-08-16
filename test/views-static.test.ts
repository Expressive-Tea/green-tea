import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, Route, Get, Module } from '../src/index';
import { buildStaticResolver } from '../src/views';

const root = join(tmpdir(), 'gt-static-test');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'index.html'), '<h1>Home</h1>');
writeFileSync(join(root, 'app.css'), 'body{}');
writeFileSync(join(tmpdir(), 'gt-secret.txt'), 'TOP SECRET');

// Bytes that no text encoding round-trips: a NUL, a lone high byte, an invalid UTF-8 sequence.
const binary = Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x0d, 0x0a, 0x1a, 0x0a]);
writeFileSync(join(root, 'pixel.bin'), binary);

@Route('/api')
class Api {
  @Get('/ping')
  ping() {
    return { ok: true };
  }
}
@Module({ mountpoint: '/', controllers: [Api] })
class M {}
const app = createApp({ modules: [M], static: root });

describe('static serving', () => {
  it('serves a file by path with its content-type', async () => {
    const res = await app.fetch(new Request('http://x/app.css'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await res.text()).toBe('body{}');
  });
  // Static serving is the only path that puts a Buffer into a buffered outcome, so it is the only
  // integration cover for the Buffer→BodyInit conversion in the Fetch adapter. Every other assertion
  // in this file is text, which survives a conversion that mangles bytes; this one does not.
  it('serves binary bytes exactly', async () => {
    const res = await app.fetch(new Request('http://x/pixel.bin'));
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(binary.byteLength);
    expect([...bytes]).toEqual([...binary]);
  });
  it('serves index.html for /', async () => {
    expect(await (await app.fetch(new Request('http://x/'))).text()).toBe('<h1>Home</h1>');
  });
  it('declared routes win over static', async () => {
    expect(await (await app.fetch(new Request('http://x/api/ping'))).json()).toEqual({ ok: true });
  });
  it('returns 404 for a missing file', async () => {
    expect((await app.fetch(new Request('http://x/nope.html'))).status).toBe(404);
  });
  it('rejects path traversal', async () => {
    const res = await app.fetch(new Request('http://x/../gt-secret.txt'));
    expect(res.status).toBe(404);
  });
  it('answers HEAD with headers and no body', async () => {
    const res = await app.fetch(new Request('http://x/app.css', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
  it('resolver refuses to escape its root', async () => {
    const resolve = buildStaticResolver(root);
    expect(await resolve('/../gt-secret.txt')).toBeUndefined();
    expect(await resolve('/%2e%2e/gt-secret.txt')).toBeUndefined();
  });
});
