import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, Route, Get, Sse, Transformer, Html, Module } from '../src/index';

const dir = join(tmpdir(), 'gt-views-test');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'dash.html'), '<h1>Dash</h1>');
writeFileSync(join(dir, 'user.html'), '<h1>Hi {{ name }}</h1>');

@Route('/')
class Views {
  @Get('/str') @Html str() { return '<p>inline</p>'; }
  @Get('/dash') @Html('dash.html') dash() {}
  @Get('/user') @Html('user.html', { template: true }) user() { return { name: '<b>D</b>' }; }
}
@Module({ mountpoint: '/', controllers: [Views] })
class M {}
const app = createApp({ modules: [M], views: dir });

describe('@Html modes', () => {
  it('string mode sends the handler return as text/html', async () => {
    const res = await app.fetch(new Request('http://x/str'));
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<p>inline</p>');
  });
  it('path mode serves the file and ignores the return', async () => {
    expect(await (await app.fetch(new Request('http://x/dash'))).text()).toBe('<h1>Dash</h1>');
  });
  it('template mode renders the file with returned data, escaping by default', async () => {
    expect(await (await app.fetch(new Request('http://x/user'))).text()).toBe('<h1>Hi &lt;b&gt;D&lt;/b&gt;</h1>');
  });
});

describe('@Html boot validation', () => {
  it('rejects @Html on a streaming (SSE) route', () => {
    @Route('/') class Bad { @Sse('/s') @Html s() { return (async function* () {})(); } }
    @Module({ mountpoint: '/', controllers: [Bad] }) class BM {}
    expect(() => createApp({ modules: [BM] })).toThrow(/@Html/);
  });
  it('rejects @Html combined with @Transformer', () => {
    const t = (v: unknown) => ({ status: 200, headers: {}, body: String(v) });
    @Route('/') class Bad2 { @Get('/g') @Html @Transformer(t) g() { return ''; } }
    @Module({ mountpoint: '/', controllers: [Bad2] }) class BM2 {}
    expect(() => createApp({ modules: [BM2] })).toThrow(/@Html and @Transformer/);
  });
});

describe('viewEngine override', () => {
  it('uses a bring-your-own engine for template mode', async () => {
    const app2 = createApp({
      modules: [M],
      views: dir,
      viewEngine: (source, data: any) => source.replace('{{ name }}', `RAW:${data.name}`),
    });
    expect(await (await app2.fetch(new Request('http://x/user'))).text()).toBe('<h1>Hi RAW:<b>D</b></h1>');
  });
});
