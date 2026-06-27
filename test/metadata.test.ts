import 'reflect-metadata';
import { expect, test, describe, it } from 'vitest';
import {
  Provider, Step, Route, Get, Module,
  getProviderMeta, getStepMeta, getRoutes, getModuleMeta,
  Sse, Ws, Stream, Post,
} from '../src/metadata';

@Provider({ provides: 'db', needs: ['config'] })
class Db { provide() { return { db: 1 }; } }

@Step({ provides: 'user', needs: ['db', 'req'], optional: false })
class Auth { run() { return { user: 'x' }; } }

@Route('/users')
class Ctl { @Get('/:id') getUser() { return 1; } }

@Module({ mountpoint: '/api', providers: [Db], steps: [Auth], controllers: [Ctl] })
class ApiModule {}

test('provider metadata is readable', () => {
  expect(getProviderMeta(Db)).toEqual({ provides: 'db', needs: ['config'], optional: false });
});

test('step metadata is readable', () => {
  expect(getStepMeta(Auth)).toEqual({ provides: 'user', needs: ['db', 'req'], optional: false });
});

test('routes carry method, path and handler name', () => {
  expect(getRoutes(Ctl)).toEqual([{ method: 'GET', path: '/users/:id', handlerName: 'getUser', transport: 'buffer' }]);
});

test('module metadata lists members', () => {
  const m = getModuleMeta(ApiModule)!;
  expect(m.mountpoint).toBe('/api');
  expect(m.providers).toEqual([Db]);
  expect(m.steps).toEqual([Auth]);
  expect(m.controllers).toEqual([Ctl]);
});

describe('stream route decorators', () => {
  it('records transport + method per decorator', () => {
    class StreamCtl {
      @Sse('/feed') feed() {}
      @Ws('/chat') chat() {}
      @Stream('/either') either() {}
      @Post('/make') make() {}
    }
    const byName = Object.fromEntries(getRoutes(StreamCtl).map((r) => [r.handlerName, r]));
    expect(byName.feed).toMatchObject({ method: 'GET', transport: 'sse', path: '/feed' });
    expect(byName.chat).toMatchObject({ method: 'GET', transport: 'ws', path: '/chat' });
    expect(byName.either).toMatchObject({ method: 'GET', transport: 'negotiate', path: '/either' });
    expect(byName.make).toMatchObject({ method: 'POST', transport: 'buffer', path: '/make' });
  });
});
