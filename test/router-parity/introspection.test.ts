/**
 * Introspection goldens (ROUTER-CORPUS §3, CARD-09). `graph()`, `explain()` and `openapi()` read
 * `routePlans` in declaration order and must never be derived from a lookup index. Compared as
 * parsed structures with array order and key order held — see `expectFrozenEqual`.
 */
import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { describe, it } from 'vitest';
import {
  createApp,
  Provider,
  Step,
  Route,
  Get,
  Head,
  Post,
  Put,
  Delete,
  Options,
  Sse,
  Stream,
  Ws,
  Module,
  needs,
  param,
  query,
  body,
} from '../../src/index';
import type { Logger } from '../../src/logger';
import { errorOutcome } from './matcher';
import { frozen, expectFrozenEqual } from './frozen';

const slugSchema = {
  '~standard': { version: 1 as const, vendor: 'parity', validate: (v: unknown) => ({ value: v }) },
};

@Provider({ provides: 'db' })
class Db {
  provide() {
    return { db: {} };
  }
}

@Step({ provides: 'user', needs: ['db'] })
class Auth {
  run() {
    return { user: {} };
  }
}

@Step({ provides: 'audit', needs: [] })
class Audit {
  run() {
    return { audit: {} };
  }
}

// Declaration order is deliberately not specificity order, and paths repeat across methods, so
// any traversal-ordered output would differ from this one.
@Route('/items')
class Items {
  @Get('/:id/files/:path*') files(@param('path') _p: string) {
    return {};
  }
  @Get('/') list(@needs('user') _u: unknown) {
    return [];
  }
  @Post('/') create(@body() _b: unknown, @needs('user') _u: unknown) {
    return {};
  }
  @Get('/:id(\\d+)') get(@param('id') _id: string, @query('expand') _e: string) {
    return {};
  }
  @Head('/:id(\\d+)') head() {
    return {};
  }
  @Options('/:id(\\d+)') options() {
    return {};
  }
  @Delete('/:id(\\d+)') remove(@needs('audit') _a: unknown) {
    return {};
  }
  @Put('/:slug([a-z0-9-]+)') upsert(@body(slugSchema) _b: unknown) {
    return {};
  }
  @Get('/search') search() {
    return [];
  }
}

@Route('/')
class Streams {
  @Sse('/events') events() {
    return (async function* () {})();
  }
  @Stream('/feed') feed() {
    return (async function* () {})();
  }
  @Ws('/live/:room') live(@needs('user') _u: unknown) {
    return (async function* () {})();
  }
}

@Module({ mountpoint: '/api', providers: [Db], steps: [Auth, Audit], controllers: [Items, Streams] })
class IntrospectionModule {}

const EXPLAINED = ['/api/items/:id(\\d+)', '/api/items', '/api/live/:room', '/api/items/:id/files/:path*'];
const NOT_DECLARED = ['/api/missing', '/api/items/42', '/api/items/'];

function explainAll(explain: (pattern: string) => unknown) {
  return [...EXPLAINED, ...NOT_DECLARED].map((pattern) => {
    try {
      return { pattern, explain: explain(pattern) };
    } catch (error) {
      return { pattern, error: errorOutcome(error) };
    }
  });
}

function capture() {
  const app = createApp({ modules: [IntrospectionModule] });
  return {
    graph: app.graph(),
    explain: explainAll(app.explain),
    openapi: app.openapi({ title: 'Parity', version: '1' }),
  };
}

// ── mesh ────────────────────────────────────────────────────────────────────────────────────────

const SECRET = 'parity-secret';

@Step({ provides: 'config', needs: [], export: true })
class Config {
  run() {
    return { config: {} };
  }
}

@Route('/remote')
class RemoteCtl {
  @Get('/ping', { export: true }) ping() {
    return { from: 'teapot' };
  }
}
@Module({ mountpoint: '/api', steps: [Config], controllers: [RemoteCtl] })
class TeapotModule {}

@Route('/local')
class LocalCtl {
  @Get('/who') who(@needs('config') _c: unknown) {
    return { from: 'teacup' };
  }
  @Get('/:id') byId() {
    return {};
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function attempt<T>(fn: () => T): { value: T } | { error: ReturnType<typeof errorOutcome> } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: errorOutcome(error) };
  }
}

async function captureMesh() {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const server = await teapot.listen(0);
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/__mesh__/control`;
  const anonymize = (value: unknown) => JSON.parse(JSON.stringify(value).split(url).join('<teapot>'));
  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    logger: quiet,
    mesh: { teapots: [{ url, secret: SECRET }] },
  });

  try {
    const before = {
      graph: attempt(() => teacup.graph()),
      explain: attempt(() => teacup.explain('/api/local/who')),
      openapi: attempt(() => teacup.openapi({ title: 'Parity', version: '1' })),
    };
    await teacup.ready();
    const after = {
      graph: teacup.graph(),
      explain: explainAll(teacup.explain).filter(({ pattern }) => pattern === '/api/missing'),
      explainLocal: teacup.explain('/api/local/who'),
      explainRemote: attempt(() => teacup.explain('/api/remote/ping')),
      openapi: teacup.openapi({ title: 'Parity', version: '1' }),
    };
    // Remote routes are reachable for lookup even though they are absent from routePlans.
    const res = await teacup.fetch(new Request('http://parity.test/api/remote/ping'));
    const lookup = { path: '/api/remote/ping', status: res.status, body: await res.text() };
    return anonymize({ before, after, lookup });
  } finally {
    await teacup.close();
    await teapot.close();
  }
}

describe('router parity: introspection goldens', () => {
  it('graph() equals the golden, routes in declaration order', async () => {
    const expected = await frozen('golden-graph', () => capture().graph);
    expectFrozenEqual(capture().graph, expected, 'graph()');
  });

  it('explain() for declared patterns and the `no route:` error equals the golden', async () => {
    const expected = await frozen('golden-explain', () => capture().explain);
    expectFrozenEqual(capture().explain, expected, 'explain()');
  });

  it("openapi({ title: 'Parity', version: '1' }) equals the golden", async () => {
    const expected = await frozen('golden-openapi', () => capture().openapi);
    expectFrozenEqual(capture().openapi, expected, 'openapi()');
  });

  it('a mesh teacup before and after ready() equals the golden; remote routes stay out of routePlans', async () => {
    const expected = await frozen('golden-mesh', captureMesh);
    expectFrozenEqual(await captureMesh(), expected, 'mesh introspection');
  }, 30_000);
});
