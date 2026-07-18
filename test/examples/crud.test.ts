import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../../example/crud';

let base: string; let server: any;
const url = (p: string) => `${base}${p}`;
afterAll(() => server?.close());

describe('crud example', () => {
  it('supports create / read / update / delete', async () => {
    server = await app.listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`;
    const created = await fetch(url('/api/todos'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'a' }) }).then((r) => r.json() as Promise<{ id: string; title: string; done: boolean }>);
    expect(created).toMatchObject({ title: 'a' });
    const id = created.id;
    expect(await fetch(url(`/api/todos/${id}`)).then((r) => r.json())).toMatchObject({ title: 'a' });
    await fetch(url(`/api/todos/${id}`), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) });
    expect(await fetch(url(`/api/todos/${id}`)).then((r) => r.json())).toMatchObject({ done: true });
    const list = await fetch(url('/api/todos')).then((r) => r.json());
    expect(Array.isArray(list)).toBe(true);
    const del = await fetch(url(`/api/todos/${id}`), { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await fetch(url(`/api/todos/${id}`))).status).toBe(404);
  });

  it('accepts urlencoded form bodies', async () => {
    const res = await fetch(url('/api/todos'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=form' });
    expect(await res.json()).toMatchObject({ title: 'form' });
  });
});
