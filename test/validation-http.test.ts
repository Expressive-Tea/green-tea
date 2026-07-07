import { describe, it, expect, afterEach } from 'vitest';
import { createApp, Route, Get, Post, Module, body, query, param } from '../src';

const numQuery = { '~standard': { version: 1 as const, vendor: 't', validate: (v: any) => {
  const n = Number(v?.page); return Number.isNaN(n) ? { issues: [{ message: 'bad', path: ['page'] }] } : { value: { page: n } }; } } };
const userBody = { '~standard': { version: 1 as const, vendor: 't', validate: (v: any) =>
  (typeof v?.email === 'string' && v.email.includes('@')) ? { value: v } : { issues: [{ message: 'Invalid email', path: ['email'] }] } } };
const idParam = { '~standard': { version: 1 as const, vendor: 't', validate: (v: any) => {
  const n = Number(v); return Number.isNaN(n) ? { issues: [{ message: 'nan', path: [] }] } : { value: n }; } } };

let app: any;
afterEach(async () => { await app?.close(); });

describe('validation over http', () => {
  it('valid body → 200 with parsed value; query coerced to number; param coerced', async () => {
    @Route('/') class C {
      @Post('/u') create(@body(userBody) b: any) { return { ok: b.email }; }
      @Get('/list') list(@query(numQuery) q: any) { return { page: q.page, isNum: typeof q.page === 'number' }; }
      @Get('/u/:id') get(@param('id', idParam) id: any) { return { id, isNum: typeof id === 'number' }; }
    }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const ok = await fetch(`http://127.0.0.1:${port}/u`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.com' }) });
    expect(await ok.json()).toEqual({ ok: 'a@b.com' });
    const li = await fetch(`http://127.0.0.1:${port}/list?page=2`);
    expect(await li.json()).toEqual({ page: 2, isNum: true });
    const g = await fetch(`http://127.0.0.1:${port}/u/7`);
    expect(await g.json()).toEqual({ id: 7, isNum: true });
  });

  it('invalid body → 422 with source + issues', async () => {
    @Route('/') class C { @Post('/u') create(@body(userBody) b: any) { return b; } }
    @Module({ mountpoint: '/', controllers: [C] }) class CMod {}
    app = createApp({ modules: [CMod] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/u`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nope' }) });
    expect(r.status).toBe(422);
    expect(await r.json()).toEqual({ error: 'Validation failed', source: 'body', issues: [{ path: 'email', message: 'Invalid email' }] });
  });
});
