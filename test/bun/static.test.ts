// Static-file confinement (#106) under the real Bun runtime, which reaches `realpath` through its
// `node:fs` compat — a third implementation of symlink resolution, so not something to assume from
// the Node suite.
//
// Run with: npm run test:bun
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/index.ts';

const base = mkdtempSync(join(tmpdir(), 'gt-static-bun-'));
const root = join(base, 'root');
mkdirSync(join(root, 'sub'), { recursive: true });
writeFileSync(join(root, 'a.txt'), 'in root');
writeFileSync(join(root, 'sub', 'index.html'), '<h1>Sub</h1>');
writeFileSync(join(base, 'secret.txt'), 'TOP SECRET');
symlinkSync('a.txt', join(root, 'in-link'));
symlinkSync('../secret.txt', join(root, 'out-link'));
symlinkSync('../nope.txt', join(root, 'dangling'));
symlinkSync('root', join(base, 'root-alias'));

const app = createApp({ modules: [], static: root });
const get = (path: string) => app.fetch(new Request(`http://x${path}`));

test('static on Bun: a link to a file outside the root is a miss', async () => {
  const res = await get('/out-link');
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain('TOP SECRET');
});

test('static on Bun: a link to a file inside the root is served', async () => {
  const res = await get('/in-link');
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('in root');
});

test('static on Bun: a dangling link is a 404, not a rejection', async () => {
  expect((await get('/dangling')).status).toBe(404);
});

test('static on Bun: a root that is itself a symlink still serves its files', async () => {
  const aliased = createApp({ modules: [], static: join(base, 'root-alias') });
  const a = await aliased.fetch(new Request('http://x/a.txt'));
  expect(a.status).toBe(200);
  expect(await a.text()).toBe('in root');
  const sub = await aliased.fetch(new Request('http://x/sub/'));
  expect(sub.status).toBe(200);
  expect(await sub.text()).toBe('<h1>Sub</h1>');
});
