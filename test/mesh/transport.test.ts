import { describe, it, expect } from 'vitest';
import { createApp, Provider, Route, Get, Module, needs } from '../../src/index';
import { untransportable } from '../../src/mesh/protocol';

describe('untransportable', () => {
  it('passes the shapes JSON actually round-trips', () => {
    expect(untransportable({ a: 1, b: 'x', c: true, d: null, e: [1, { f: 2 }] })).toBeUndefined();
    expect(untransportable([])).toBeUndefined();
    expect(untransportable('plain')).toBeUndefined();
    expect(untransportable(Object.create(null))).toBeUndefined();
  });

  it('names the class whose identity JSON would discard, and where it sits', () => {
    class RemotePool {
      query() {
        return 1;
      }
    }

    expect(untransportable({ db: new RemotePool() })).toEqual({ path: 'result.db', what: 'a RemotePool instance' });
    expect(untransportable({ seen: new Map() })).toEqual({ path: 'result.seen', what: 'a Map instance' });
    // refused rather than quietly delivered as a string, which is the same silent difference smaller
    expect(untransportable({ at: new Date() })).toEqual({ path: 'result.at', what: 'a Date instance' });
  });

  it('finds behaviour nested in arrays and objects', () => {
    expect(untransportable({ list: [1, { run: () => 1 }] })).toEqual({
      path: 'result.list[1].run',
      what: 'a function',
    });
  });

  it('gives up rather than rejecting a payload too large to check', () => {
    const huge: Record<string, unknown> = {};
    for (let i = 0; i < 11_000; i++) huge[`k${i}`] = i;
    huge.late = () => 1; // past the budget: assumed fine rather than turned into an error

    expect(untransportable(huge)).toBeUndefined();
  });
});

class Pool {
  query(sql: string) {
    return `ran:${sql}`;
  }
}

@Provider({ provides: 'db', export: true })
class Db {
  provide() {
    return { db: new Pool() };
  }
}
@Module({ mountpoint: '/api', providers: [Db] })
class TeapotModule {}

@Route('/local')
class Ctl {
  @Get('/use')
  use(@needs('db') db: any) {
    return { got: typeof db };
  }
}
@Module({ mountpoint: '/api', controllers: [Ctl] })
class TeacupModule {}

describe('exporting a handle over the mesh', () => {
  it('fails with a message naming the token, instead of delivering an empty object', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: 'x' } });
    const server = await teapot.listen(0);
    const port = (server.address() as { port: number }).port;

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: 'x' }] },
    });

    try {
      // before this guard: HTTP 200 with `{}` — an object that passes any truthiness check and
      // then throws "db.query is not a function" somewhere else entirely
      await expect(teacup.fetch(new Request('http://x/api/local/use'))).rejects.toThrow(
        /mesh cannot transport 'db'[\s\S]*Pool instance/,
      );
    } finally {
      await teacup.close();
      await teapot.close();
      server.close();
    }
  });
});
