import 'reflect-metadata';
import { describe, expect, it, test, vi } from 'vitest';
import { Provider, Step, Route, Get, Module, Transformer } from '../src/metadata';
import { JsonTransformer } from '../src/transformers';
import { Unauthorized } from '../src/signals';
import { createApp } from '../src/app';
import { needs, param, query } from '../src/params';

@Provider({ provides: 'db' })
class Db { provide() { return { db: { find: (t: string) => (t === 'good' ? { id: 'u1' } : null) } }; } }

@Step({ provides: 'user', needs: ['db', 'req'] })
class Auth {
  run(ctx: any) {
    const user = ctx.db.find(ctx.req.headers['x-token']);
    if (!user) throw new Unauthorized('bad token');
    return { user };
  }
}

@Route('/users')
class UserCtl {
  @Get('/:id')
  @Transformer(JsonTransformer)
  getUser(@needs('user') user: any, @param('id') id: string) { return { id, user }; }
}

@Module({ mountpoint: '/api', providers: [Db], steps: [Auth], controllers: [UserCtl] })
class ApiModule {}

test('inspect lists the ordered chain with origins', () => {
  const app = createApp({ modules: [ApiModule] });
  const lines = app.inspect('/api/users/:id');
  expect(lines.map((l) => `${l.kind}:${l.name}`)).toEqual(['provider:db', 'step:user', 'handler:getUser']);
});

test('a logger plugin observes step:enter without mutating the chain', async () => {
  const seen: string[] = [];
  const logger = (api: any) => api.bus.on('request:step:enter', (p: any) => seen.push(p.name));
  const app = createApp({ modules: [ApiModule], plugins: [logger] });
  const server = await app.listen(0);
  const port = (server.address() as any).port;

  const ok = await fetch(`http://127.0.0.1:${port}/api/users/7`, { headers: { 'x-token': 'good' } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ id: '7', user: { id: 'u1' } });
  expect(seen).toContain('user');

  const bad = await fetch(`http://127.0.0.1:${port}/api/users/7`, { headers: { 'x-token': 'nope' } });
  expect(bad.status).toBe(401);

  server.close();
});

test('required provider failure aborts boot', () => {
  @Provider({ provides: 'broken' })
  class Broken { provide() { throw new Error('cannot connect'); } }
  @Module({ mountpoint: '/x', providers: [Broken], steps: [], controllers: [] })
  class BrokenModule {}

  const app = createApp({ modules: [BrokenModule] });
  return expect(app.listen(0)).rejects.toThrow(/provider 'broken' failed/);
});

test('optional provider failure warns but does not abort boot', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  @Provider({ provides: 'cache', optional: true })
  class FlakyCache { provide() { throw new Error('cache down'); } }
  @Route('/ping')
  class PingCtl { @Get('/') ping() { return { ok: true }; } }
  @Module({ mountpoint: '/sys', providers: [FlakyCache], steps: [], controllers: [PingCtl] })
  class SysModule {}

  const app = createApp({ modules: [SysModule] });
  const server = await app.listen(0);            // must NOT throw
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("optional provider 'cache' failed"));
  server.close();
  warn.mockRestore();
});

test('handler receives @query value through a live request', async () => {
  @Route('/search')
  class SearchCtl {
    @Get('/')
    run(@query('q') q: string) { return { q }; }
  }
  @Module({ mountpoint: '/s', providers: [], steps: [], controllers: [SearchCtl] })
  class SearchModule {}

  const app = createApp({ modules: [SearchModule] });
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}/s/search/?q=hello`);
  expect(await res.json()).toEqual({ q: 'hello' });
  server.close();
});

test('boot fails when a handler needs something nothing provides', () => {
  @Route('/things')
  class ThingCtl {
    @Get('/')
    list(@needs('missing') _m: any) { return []; }
  }
  @Module({ mountpoint: '/t', providers: [], steps: [], controllers: [ThingCtl] })
  class ThingModule {}

  expect(() => createApp({ modules: [ThingModule] }))
    .toThrow(/handler 'list' needs 'missing'/);
});

import { Sse, Ws } from '../src/metadata';
import { inbound } from '../src/params';
import { channel } from '../src/channel';

describe('app streaming wiring', () => {
  it('serves an SSE route declared with @Sse', async () => {
    @Route('/')
    class Ctl {
      @Sse('/ticks') ticks() {
        return (async function* () { yield { t: 1 }; yield { t: 2 }; })();
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl] }) class M {}
    const app = createApp({ modules: [M] });
    const server = await app.listen(0);
    const addr = server.address() as import('net').AddressInfo;
    const res = await fetch(`http://127.0.0.1:${addr.port}/ticks`, { headers: { accept: 'text/event-stream' } });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: {"t":1}');
    server.close();
  });

  it('serves a @Ws route receiving @inbound and returning a channel', async () => {
    @Route('/')
    class Ctl {
      @Ws('/echo') echo(@inbound() inc: AsyncIterable<string>) {
        const out = channel<string>();
        (async () => { for await (const m of inc) out.push(`re:${m}`); out.close(); })();
        return out;
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl] }) class M {}
    const app = createApp({ modules: [M] });
    const server = await app.listen(0);
    const addr = server.address() as import('net').AddressInfo;
    const WebSocket = (await import('ws')).default;
    const client = new WebSocket(`ws://127.0.0.1:${addr.port}/echo`);
    await new Promise((r) => client.on('open', r));
    const got = new Promise<string>((r) => client.on('message', (d: Buffer) => r(d.toString())));
    client.send('yo');
    expect(await got).toBe('re:yo');
    client.close(); server.close();
  });
});

describe('graceful shutdown', () => {
  it('app.close() stops accepting and resolves, even with an SSE stream open', async () => {
    @Route('/')
    class Ctl { @Sse('/ticks') ticks() { return (async function* () { yield { t: 1 }; await new Promise((r) => setTimeout(r, 1000)); yield { t: 2 }; })(); } }
    @Module({ mountpoint: '/', controllers: [Ctl] }) class M {}
    const app = createApp({ modules: [M] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/ticks`, { headers: { accept: 'text/event-stream' } });
    const reader = res.body!.getReader();
    await reader.read();                       // first event; stream still open

    await app.close();                         // must NOT hang despite the open stream
    await expect(fetch(`http://127.0.0.1:${port}/ticks`).then((r) => r.text())).rejects.toThrow();
    reader.cancel().catch(() => {});
  });
});
