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
