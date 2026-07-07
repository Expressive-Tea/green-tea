import { describe, it, expect, afterEach } from 'vitest';
import { createApp, Route, Post, Module, body } from '../src';

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
