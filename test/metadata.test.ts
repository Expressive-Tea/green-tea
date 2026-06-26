import 'reflect-metadata';
import { expect, test } from 'vitest';
import {
  Provider, Step, Route, Get, Module,
  getProviderMeta, getStepMeta, getRoutes, getModuleMeta,
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
  expect(getRoutes(Ctl)).toEqual([{ method: 'GET', path: '/users/:id', handlerName: 'getUser' }]);
});

test('module metadata lists members', () => {
  const m = getModuleMeta(ApiModule)!;
  expect(m.mountpoint).toBe('/api');
  expect(m.providers).toEqual([Db]);
  expect(m.steps).toEqual([Auth]);
  expect(m.controllers).toEqual([Ctl]);
});
