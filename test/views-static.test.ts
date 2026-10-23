import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, Route, Get, Module } from '../src/index';
import { buildStaticResolver } from '../src/views';
import { isHttpError } from '../src/signals';
import type { ErrorRenderer } from '../src/transformers';

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

// #106: the traversal guard above is lexical, and `stat`/`readFile` follow symlinks, so a link
// inside the root could serve a file outside it. Confinement has to compare real paths. On macOS
// `tmpdir()` is itself behind a symlink (`/var` → `/private/var`), so every case below also
// exercises a root whose lexical and real paths differ.
describe('static serving confined to the real root (#106)', () => {
  const base = mkdtempSync(join(tmpdir(), 'gt-static-real-'));
  const sroot = join(base, 'root');
  mkdirSync(join(sroot, 'sub'), { recursive: true });
  mkdirSync(join(sroot, 'idx'));
  mkdirSync(join(base, 'root-evil'));
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(sroot, 'a.txt'), 'in root');
  writeFileSync(join(sroot, 'sub', 'index.html'), '<h1>Sub</h1>');
  writeFileSync(join(base, 'root-evil', 'x.txt'), 'SIBLING');
  writeFileSync(join(base, 'secret.txt'), 'TOP SECRET');
  writeFileSync(join(base, 'outside', 's.txt'), 'OUTSIDE');

  // Windows without the symlink privilege refuses to create links; the cases that need them skip
  // there rather than pass vacuously.
  let symlinks = true;

  try {
    symlinkSync('a.txt', join(sroot, 'in-link'));
    symlinkSync('../secret.txt', join(sroot, 'out-link'));
    symlinkSync('../outside', join(sroot, 'dir-link'));
    symlinkSync('../nope.txt', join(sroot, 'dangling'));
    symlinkSync('../root-evil/x.txt', join(sroot, 'evil-link'));
    symlinkSync('../../secret.txt', join(sroot, 'idx', 'index.html'));
    symlinkSync('root', join(base, 'root-alias'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    symlinks = false;
  }

  const withLinks = it.skipIf(!symlinks);

  const app = createApp({ modules: [], static: sroot });
  const get = (path: string) => app.fetch(new Request(`http://x${path}`));

  withLinks('T1: does not serve a link to a file outside the root', async () => {
    const res = await get('/out-link');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('TOP SECRET');
  });
  withLinks('T2: serves a link to a file inside the root', async () => {
    const res = await get('/in-link');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('in root');
  });
  withLinks('T3: a symlinked directory cannot expose an out-of-root file', async () => {
    expect((await get('/dir-link/s.txt')).status).toBe(404);
  });
  it('T4: a sibling-prefix directory is not reachable by traversal', async () => {
    expect((await get('/../root-evil/x.txt')).status).toBe(404);
    expect((await get('/%2e%2e/root-evil/x.txt')).status).toBe(404);
  });
  withLinks('T5: a real path in a sibling-prefix directory is outside the root', async () => {
    const resolve = buildStaticResolver(sroot);
    expect(await resolve('/../root-evil/x.txt')).toBeUndefined();
    // Passes the lexical guard, then really lands in `root-evil` — only the `root + sep` rule on the
    // real path stops it.
    expect(await resolve('/evil-link')).toBeUndefined();
  });
  withLinks('T6: a dangling link is a miss, not a rejection', async () => {
    await expect(buildStaticResolver(sroot)('/dangling')).resolves.toBeUndefined();
    expect((await get('/dangling')).status).toBe(404);
  });
  withLinks('T7: a directory index that links outside the root is a miss', async () => {
    const res = await get('/idx/');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('TOP SECRET');
  });
  withLinks('T8: a root that is itself a symlink still serves its files', async () => {
    const aliased = createApp({ modules: [], static: join(base, 'root-alias') });
    const a = await aliased.fetch(new Request('http://x/a.txt'));
    expect(a.status).toBe(200);
    expect(await a.text()).toBe('in root');
    const sub = await aliased.fetch(new Request('http://x/sub/'));
    expect(sub.status).toBe(200);
    expect(await sub.text()).toBe('<h1>Sub</h1>');
  });
  withLinks('T10: an escape renders through onError exactly like a plain miss', async () => {
    const onError: ErrorRenderer = (error) => ({
      status: isHttpError(error) ? error.status : 500,
      headers: { 'content-type': 'text/html' },
      body: `<h1>${isHttpError(error) ? error.status : 500}</h1>`,
    });
    const custom = createApp({ modules: [], static: sroot, onError });
    const escape = await custom.fetch(new Request('http://x/out-link'));
    const miss = await custom.fetch(new Request('http://x/nope.txt'));
    expect(escape.status).toBe(404);
    expect(escape.headers.get('content-type')).toBe('text/html');
    expect(await escape.text()).toBe(await miss.text());
  });
});

it('a root created after the first request starts serving without a restart', async () => {
  const late = join(mkdtempSync(join(tmpdir(), 'gt-static-late-')), 'public');
  const resolve = buildStaticResolver(late);
  expect(await resolve('/a.txt')).toBeUndefined();
  mkdirSync(late);
  writeFileSync(join(late, 'a.txt'), 'late');
  expect((await (await resolve('/a.txt'))?.read())?.toString()).toBe('late');
});
