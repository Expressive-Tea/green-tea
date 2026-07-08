import 'reflect-metadata';
import { describe, expect, it, test, vi } from 'vitest';
import { Provider, Step, Route, Get, Post, Module, Transformer } from '../src/metadata';
import { JsonTransformer } from '../src/transformers';
import { Unauthorized } from '../src/signals';
import { createApp } from '../src/app';
import { needs, param, query, body } from '../src/params';

@Provider({ provides: 'db' })
class Db {
  provide() {
    return { db: { find: (t: string) => (t === 'good' ? { id: 'u1' } : null) } };
  }
}

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
  getUser(@needs('user') user: any, @param('id') id: string) {
    return { id, user };
  }
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
  class Broken {
    provide() {
      throw new Error('cannot connect');
    }
  }
  @Module({ mountpoint: '/x', providers: [Broken], steps: [], controllers: [] })
  class BrokenModule {}

  const app = createApp({ modules: [BrokenModule] });
  return expect(app.listen(0)).rejects.toThrow(/provider 'broken' failed/);
});

test('optional provider failure warns but does not abort boot', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  @Provider({ provides: 'cache', optional: true })
  class FlakyCache {
    provide() {
      throw new Error('cache down');
    }
  }
  @Route('/ping')
  class PingCtl {
    @Get('/') ping() {
      return { ok: true };
    }
  }
  @Module({ mountpoint: '/sys', providers: [FlakyCache], steps: [], controllers: [PingCtl] })
  class SysModule {}

  const app = createApp({ modules: [SysModule] });
  expect(app.degraded()).toEqual([]); // nothing degraded until boot runs
  const server = await app.listen(0); // must NOT throw
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("optional provider 'cache' failed"));
  // boot ends with a summary of everything running degraded, and it is queryable on the app
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('started with 1 degraded optional provider(s): cache'));
  expect(app.degraded()).toEqual(['cache']);
  server.close();
  warn.mockRestore();
});

test('handler receives @query value through a live request', async () => {
  @Route('/search')
  class SearchCtl {
    @Get('/')
    run(@query('q') q: string) {
      return { q };
    }
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
    list(@needs('missing') _m: any) {
      return [];
    }
  }
  @Module({ mountpoint: '/t', providers: [], steps: [], controllers: [ThingCtl] })
  class ThingModule {}

  expect(() => createApp({ modules: [ThingModule] })).toThrow(/handler 'list' needs 'missing'/);
});

it('boot error for a misspelled @needs suggests the closest token', () => {
  @Step({ provides: 'user', needs: [] })
  class Auth {
    run() {
      return { user: 1 };
    }
  }
  @Route('/u')
  class Ctl {
    @Get('/x') x(@needs('usr') u: any) {
      return { u };
    }
  }
  @Module({ mountpoint: '/api', steps: [Auth], controllers: [Ctl] })
  class M {}
  expect(() => createApp({ modules: [M] })).toThrow(/did you mean 'user'\?/);
});

import { Sse, Ws } from '../src/metadata';
import { inbound } from '../src/params';
import { channel } from '../src/channel';

describe('app streaming wiring', () => {
  it('serves an SSE route declared with @Sse', async () => {
    @Route('/')
    class Ctl {
      @Sse('/ticks') ticks() {
        return (async function* () {
          yield { t: 1 };
          yield { t: 2 };
        })();
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
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
        (async () => {
          for await (const m of inc) out.push(`re:${m}`);
          out.close();
        })();
        return out;
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M] });
    const server = await app.listen(0);
    const addr = server.address() as import('net').AddressInfo;
    const WebSocket = (await import('ws')).default;
    const client = new WebSocket(`ws://127.0.0.1:${addr.port}/echo`);
    await new Promise((r) => client.on('open', r));
    const got = new Promise<string>((r) => client.on('message', (d: Buffer) => r(d.toString())));
    client.send('yo');
    expect(await got).toBe('re:yo');
    client.close();
    server.close();
  });
});

describe('per-route subgraph slicing', () => {
  it('a route that does not @needs a step does not run it', async () => {
    const ran: string[] = [];
    @Step({ provides: 'tracked', needs: [] })
    class Tracked {
      run() {
        ran.push('tracked');
        return { tracked: true };
      }
    }
    @Route('/')
    class Ctl {
      @Get('/needs') needs(@needs('tracked') t: any) {
        return { t };
      }
      @Get('/free') free() {
        return { ok: true };
      }
    }
    @Module({ mountpoint: '/', steps: [Tracked], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;

    await fetch(`http://127.0.0.1:${port}/free`).then((r) => r.json());
    expect(ran).toEqual([]); // step did NOT run for /free
    await fetch(`http://127.0.0.1:${port}/needs`).then((r) => r.json());
    expect(ran).toEqual(['tracked']); // step ran for /needs
    expect(app.inspect('/free').map((l) => l.kind)).toEqual(['handler']); // no step in the chain
    server.close();
  });

  it('a side-effect step (provides: []) added by a plugin runs unconditionally', async () => {
    // NB: @Step always provides exactly one token (always sliceable). provides:[] only arises via a plugin's scope.add.
    const ran: string[] = [];
    const observer = (api: any) =>
      api.scope.add({
        kind: 'step',
        name: 'obs',
        needs: [],
        provides: [],
        run: () => {
          ran.push('obs');
          return {};
        },
      });
    @Route('/')
    class Ctl {
      @Get('/free') free() {
        return { ok: true };
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], plugins: [observer] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    await fetch(`http://127.0.0.1:${port}/free`).then((r) => r.json());
    expect(ran).toEqual(['obs']); // ran despite the route @needs-ing nothing
    server.close();
  });

  it('an always-run observer step receives its declared needs even when the route does not need them', async () => {
    let seen: any;
    const observer = (api: any) =>
      api.scope.add({
        kind: 'step',
        name: 'audit',
        needs: ['user'],
        provides: [],
        run: (ctx: any) => {
          seen = ctx.user;
          return {};
        },
      });
    @Step({ provides: 'user', needs: [] })
    class Auth {
      run() {
        return { user: { id: 'u1' } };
      }
    }
    @Route('/')
    class Ctl {
      @Get('/free') free() {
        return { ok: true };
      }
    } // does NOT @needs('user')
    @Module({ mountpoint: '/', steps: [Auth], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], plugins: [observer] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    await fetch(`http://127.0.0.1:${port}/free`).then((r) => r.json());
    expect(seen).toEqual({ id: 'u1' }); // observer got user, not undefined
    server.close();
  });
});

import { Rooms } from '../src/rooms';
import { toMermaid as renderMermaid } from '../src/graph-viz';

describe('app.graph / explain', () => {
  it('graph() returns nodes (with origin/needs/provides) and routes with their sliced chain', async () => {
    @Provider({ provides: 'db' })
    class Db {
      provide() {
        return { db: 1 };
      }
    }
    @Step({ provides: 'user', needs: ['db'] })
    class Auth {
      run() {
        return { user: 1 };
      }
    }
    @Route('/u')
    class Ctl {
      @Get('/:id') get(@needs('user') u: any) {
        return { u };
      }
    }
    @Module({ mountpoint: '/api', providers: [Db], steps: [Auth], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M] });
    const g = app.graph();
    expect(g.nodes.find((n) => n.name === 'db')).toMatchObject({ kind: 'provider', origin: 'module:M' });
    expect(g.nodes.find((n) => n.name === 'user')).toMatchObject({ kind: 'step', needs: ['db'] });
    const route = g.routes.find((r) => r.pattern === '/api/u/:id')!;
    expect(route.chain).toEqual(['db', 'user', 'get']);
    expect(app.toMermaid()).toContain('flowchart');
  });

  it('explain() returns the rich chain with origin and a handler entry', async () => {
    @Step({ provides: 'user', needs: [] })
    class Auth {
      run() {
        return { user: 1 };
      }
    }
    @Route('/u')
    class Ctl {
      @Get('/me') me(@needs('user') u: any) {
        return { u };
      }
    }
    @Module({ mountpoint: '/api', steps: [Auth], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M] });
    const e = app.explain('/api/u/me');
    expect(e).toMatchObject({ pattern: '/api/u/me', method: 'GET', transport: 'buffer' });
    expect(e.chain.map((c) => `${c.kind}:${c.name}`)).toEqual(['step:user', 'handler:me']);
    expect(e.chain[0]).toMatchObject({ origin: 'module:M', provides: ['user'] });
  });
});

describe('devGraph endpoint', () => {
  const portOf = (s: any) => (s.address() as any).port;
  it('serves /__graph__ as HTML when devGraph:true', async () => {
    @Route('/u')
    class Ctl {
      @Get('/me') me() {
        return { ok: 1 };
      }
    }
    @Module({ mountpoint: '/api', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], devGraph: true });
    const s = await app.listen(0);
    const html = await fetch(`http://127.0.0.1:${portOf(s)}/__graph__`).then((r) => r.text());
    expect(html).toContain('class="mermaid"');
    expect(html).toContain('flowchart');
    const mmd = await fetch(`http://127.0.0.1:${portOf(s)}/__graph__`, { headers: { accept: 'text/plain' } });
    expect(mmd.headers.get('content-type')).toContain('text/plain');
    expect(await mmd.text()).toContain('flowchart');
    s.close();
  });
  it('does NOT mount /__graph__ without devGraph', async () => {
    @Route('/u')
    class Ctl {
      @Get('/me') me() {
        return { ok: 1 };
      }
    }
    @Module({ mountpoint: '/api', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M] });
    const s = await app.listen(0);
    const res = await fetch(`http://127.0.0.1:${portOf(s)}/__graph__`);
    expect(res.status).toBe(404);
    s.close();
  });
});

describe('graceful shutdown', () => {
  it('app.close() stops accepting and resolves, even with an SSE stream open', async () => {
    @Route('/')
    class Ctl {
      @Sse('/ticks') ticks() {
        return (async function* () {
          yield { t: 1 };
          await new Promise((r) => setTimeout(r, 1000));
          yield { t: 2 };
        })();
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M] });
    const server = await app.listen(0);
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/ticks`, { headers: { accept: 'text/event-stream' } });
    const reader = res.body!.getReader();
    await reader.read(); // first event; stream still open

    await app.close(); // must NOT hang despite the open stream
    await expect(fetch(`http://127.0.0.1:${port}/ticks`).then((r) => r.text())).rejects.toThrow();
    reader.cancel().catch(() => {});
  });
});

describe('overrides', () => {
  const portOf = (s: any) => (s.address() as any).port;
  it('overrides a provider token with a plain value (wrapped as a merge object)', async () => {
    @Provider({ provides: 'db' })
    class Db {
      provide() {
        return { db: { real: true } };
      }
    }
    @Route('/u')
    class Ctl {
      @Get('/x') x(@needs('db') db: any) {
        return { db };
      }
    }
    @Module({ mountpoint: '/api', providers: [Db], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], overrides: { db: { fake: true } } });
    const s = await app.listen(0);
    expect(await fetch(`http://127.0.0.1:${portOf(s)}/api/u/x`).then((r) => r.json())).toEqual({ db: { fake: true } });
    s.close();
  });
  it('overrides with a function runner', async () => {
    @Provider({ provides: 'db' })
    class Db {
      provide() {
        return { db: 'real' };
      }
    }
    @Route('/u')
    class Ctl {
      @Get('/x') x(@needs('db') db: any) {
        return { db };
      }
    }
    @Module({ mountpoint: '/api', providers: [Db], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], overrides: { db: () => ({ db: 'fn' }) } });
    const s = await app.listen(0);
    expect(await fetch(`http://127.0.0.1:${portOf(s)}/api/u/x`).then((r) => r.json())).toEqual({ db: 'fn' });
    s.close();
  });
  it('rejects an override for an unknown token', async () => {
    @Route('/u')
    class Ctl {
      @Get('/x') x() {
        return { ok: 1 };
      }
    }
    @Module({ mountpoint: '/api', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], overrides: { nope: 1 } });
    await expect(app.listen(0)).rejects.toThrow(/unknown token 'nope'/);
  });
});

describe('rooms auto-provide', () => {
  it('injects a built-in rooms instance resolvable via @needs("rooms")', async () => {
    @Route('/r')
    class Ctl {
      @Get('/x') x(@needs('rooms') rooms: Rooms) {
        return { ok: rooms instanceof Rooms };
      }
    }
    @Module({ mountpoint: '/api', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M] });
    const s = await app.listen(0);
    const port = (s.address() as any).port;
    expect(await fetch(`http://127.0.0.1:${port}/api/r/x`).then((r) => r.json())).toEqual({ ok: true });
    s.close();
  });
  it('a user-declared rooms provider wins (no duplicate-name throw)', () => {
    @Provider({ provides: 'rooms' })
    class MyRooms {
      provide() {
        return { rooms: { custom: true } };
      }
    }
    @Route('/r')
    class Ctl {
      @Get('/x') x(@needs('rooms') rooms: any) {
        return rooms;
      }
    }
    @Module({ mountpoint: '/api', providers: [MyRooms], controllers: [Ctl] })
    class M {}
    expect(() => createApp({ modules: [M] })).not.toThrow();
  });
});

test('per-route maxBodyBytes overrides the server default', async () => {
  @Route('/up')
  class C {
    @Post('/small', { maxBodyBytes: 10 }) small(@body() _b: unknown) {
      return { ok: true };
    }
    @Post('/big') big(@body() _b: unknown) {
      return { ok: true };
    }
  }
  @Module({ mountpoint: '/', providers: [], steps: [], controllers: [C] })
  class M {}

  const app = createApp({ modules: [M], limits: { maxBodyBytes: 1000 } });
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  const payload = JSON.stringify({ x: 'aaaaaaaaaaaaaaaaaaaa' }); // ~30 bytes, over the route's 10-byte cap
  const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload };

  const tight = await fetch(`http://127.0.0.1:${port}/up/small`, opts);
  expect(tight.status).toBe(413); // per-route cap of 10 bytes
  const loose = await fetch(`http://127.0.0.1:${port}/up/big`, opts);
  expect(loose.status).toBe(200); // falls back to the server's 1000-byte limit

  server.close();
});
