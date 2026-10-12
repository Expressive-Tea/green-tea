/**
 * Route introspection parity after the radix index (FPRD-001 CARD-09, #109).
 *
 * `test/router-parity/introspection.test.ts` already holds `graph()`, `explain()`, `openapi()` and the
 * mesh teacup against goldens frozen at the pre-radix revision. This file covers what those goldens
 * do not:
 *
 * - `explain()` / `inspect()` on a pattern declared under several methods with a non-GET first;
 * - the dev endpoints (`/__graph__`, `/__openapi__`) on `app.fetch`, on a Node listener and on a
 *   mesh teacup, and their agreement with the direct API;
 * - that `graph()` / `explain()` / `inspect()` / `openapi()` never consult the lookup index, and list
 *   routes in declaration order where the index ranks them differently.
 *
 * Expected values are in `test/fixtures/router-introspection-ed47836.json`. They were captured from
 * the pre-radix code at `ed47836c9820c47bf4ed5e902d91e019abdb110a` (the CARD-08 pinned revision) by
 * copying this file into a detached checkout of that commit and running
 * `INTROSPECTION_PARITY_CAPTURE=<out.json> npx vitest run test/router-introspection-parity.test.ts`.
 * They were never generated from the radix implementation. A mismatch here is a compatibility
 * failure, not a stale fixture: do not regenerate the file from current code.
 */
import 'reflect-metadata';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, Provider, Step, Route, Get, Delete, Sse, Ws, Module, needs, param, toMermaid } from '../src/index';
import type { App } from '../src/app/types';
import type { Logger } from '../src/logger';
import { graphHtml } from '../src/graph-viz';

/** Counts every call into the router's lookup entry points, the only functions that build or read the index. */
const lookups = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../src/http/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/http/router')>();
  return {
    ...actual,
    matchRoute: (...args: Parameters<typeof actual.matchRoute>) => {
      lookups.calls++;
      return actual.matchRoute(...args);
    },
    resolveRoute: (...args: Parameters<typeof actual.resolveRoute>) => {
      lookups.calls++;
      return actual.resolveRoute(...args);
    },
    allowedMethods: (...args: Parameters<typeof actual.allowedMethods>) => {
      lookups.calls++;
      return actual.allowedMethods(...args);
    },
  };
});

const REVISION = 'ed47836c9820c47bf4ed5e902d91e019abdb110a';
const FIXTURE = join(__dirname, 'fixtures', 'router-introspection-ed47836.json');
const CAPTURE_TO = process.env.INTROSPECTION_PARITY_CAPTURE;

// ── fixture app ─────────────────────────────────────────────────────────────────────────────────

@Provider({ provides: 'store' })
class Store {
  provide() {
    return { store: {} };
  }
}

@Step({ provides: 'caller', needs: ['store'] })
class Caller {
  run() {
    return { caller: {} };
  }
}

// Declared least-specific first: DELETE precedes GET at `/:id`, and the catch-all and the param come
// before the static `/latest`. The index ranks `/latest` first for GET; declaration order does not.
@Route('/docs')
class Docs {
  @Delete('/:id') remove(@param('id') id: string) {
    return { id: 'remove', param: id };
  }
  @Get('/:rest*') rest(@param('rest') rest: string) {
    return { id: 'rest', param: rest };
  }
  @Get('/:id') get(@param('id') id: string, @needs('caller') _c: unknown) {
    return { id: 'get', param: id };
  }
  @Get('/latest') latest() {
    return { id: 'latest' };
  }
  @Sse('/events') events() {
    return (async function* () {})();
  }
  @Ws('/:id/live') live(@needs('caller') _c: unknown) {
    return (async function* () {})();
  }
}

@Module({ mountpoint: '/v1', providers: [Store], steps: [Caller], controllers: [Docs] })
class DocsModule {}

const DECLARED_HANDLERS = ['remove', 'rest', 'get', 'latest', 'events', 'live'];

const PATTERNS = [
  '/v1/docs/:id', // DELETE and GET share it; DELETE is declared first
  '/v1/docs/latest',
  '/v1/docs/:rest*',
  '/v1/docs/:id/live',
  '/v1/docs/7', // a concrete request path, not a declaration
  '/v1/docs/latest/',
  '/v1/missing',
];

const REQUESTS: Array<[string, string]> = [
  ['GET', '/v1/docs/latest'],
  ['GET', '/v1/docs/7'],
  ['GET', '/v1/docs/a/b'],
  ['DELETE', '/v1/docs/7'],
  ['PUT', '/v1/docs/7'],
];

function attempt<T>(fn: () => T): { value: T } | { error: string } {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Everything introspection exposes, read straight from the app. Lookup-free by construction. */
function introspect(app: App) {
  return JSON.parse(
    JSON.stringify({
      graph: app.graph(),
      explain: PATTERNS.map((pattern) => ({ pattern, ...attempt(() => app.explain(pattern)) })),
      inspect: PATTERNS.map((pattern) => ({ pattern, ...attempt(() => app.inspect(pattern)) })),
      mermaid: app.toMermaid(),
      openapi: app.openapi({ title: 'Introspection', version: '1' }),
      openapiNoInfo: app.openapi(),
    }),
  ) as Record<string, unknown>;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface DevSeen {
  graphHtml: { status: number; type: string | null; sha256: string };
  graphText: { status: number; type: string | null; body: string };
  openapi: { status: number; type: string | null; body: unknown };
}

/** Reads the three dev-endpoint responses through any `fetch`-shaped function. */
async function devEndpoints(get: (path: string, accept?: string) => Promise<Response>): Promise<DevSeen> {
  const html = await get('/__graph__');
  const text = await get('/__graph__', 'text/plain');
  const doc = await get('/__openapi__');
  return {
    graphHtml: { status: html.status, type: html.headers.get('content-type'), sha256: sha256(await html.text()) },
    graphText: { status: text.status, type: text.headers.get('content-type'), body: await text.text() },
    openapi: { status: doc.status, type: doc.headers.get('content-type'), body: JSON.parse(await doc.text()) },
  };
}

const viaFetch = (app: App) => (path: string, accept?: string) =>
  app.fetch(new Request(`http://parity.test${path}`, accept ? { headers: { accept } } : {}));

async function lookupsThrough(app: App) {
  const out = [];

  for (const [method, path] of REQUESTS) {
    const res = await app.fetch(new Request(`http://parity.test${path}`, { method }));
    out.push({ method, path, status: res.status, allow: res.headers.get('allow'), body: await res.text() });
  }

  return out;
}

async function captureLocal() {
  const app = createApp({ modules: [DocsModule], devGraph: true, devOpenapi: true });
  const direct = introspect(app);
  const fetchDev = await devEndpoints(viaFetch(app));
  const server = await app.listen(0);

  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const nodeDev = await devEndpoints((path, accept) =>
      fetch(`${base}${path}`, accept ? { headers: { accept } } : {}),
    );
    return { direct, fetchDev, nodeDev, lookups: await lookupsThrough(app) };
  } finally {
    await app.close();
  }
}

// ── mesh fixture ────────────────────────────────────────────────────────────────────────────────

const SECRET = 'introspection-secret';

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
  @Get('/:id') byId() {
    return {};
  }
  @Get('/who') who(@needs('config') _c: unknown) {
    return { from: 'teacup' };
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function captureMesh() {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  const server = await teapot.listen(0);
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/__mesh__/control`;
  const anonymize = (text: string) => text.split(url).join('<teapot>');
  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    logger: quiet,
    devGraph: true,
    devOpenapi: true,
    mesh: { teapots: [{ url, secret: SECRET }] },
  });

  try {
    const before = {
      graph: attempt(() => teacup.graph()),
      explain: attempt(() => teacup.explain('/api/local/who')),
      inspect: attempt(() => teacup.inspect('/api/local/who')),
      openapi: attempt(() => teacup.openapi()),
    };
    await teacup.ready();
    const after = introspectMesh(teacup);
    const dev = await devEndpoints(async (path, accept) => {
      const res = await viaFetch(teacup)(path, accept);
      // The teapot URL carries an ephemeral port; replace it before hashing or comparing.
      return new Response(anonymize(await res.text()), { status: res.status, headers: res.headers });
    });
    const res = await teacup.fetch(new Request('http://parity.test/api/remote/ping'));
    const lookup = { path: '/api/remote/ping', status: res.status, body: await res.text() };
    return {
      result: JSON.parse(anonymize(JSON.stringify({ before, after, dev, lookup }))) as {
        before: unknown;
        after: ReturnType<typeof introspectMesh>;
        dev: DevSeen;
        lookup: unknown;
      },
      anonymize,
      teacup,
    };
  } finally {
    await teacup.close();
    await teapot.close();
  }
}

function introspectMesh(app: App) {
  return {
    graph: app.graph(),
    explain: ['/api/local/who', '/api/local/:id', '/api/remote/ping', '/api/local/7'].map((pattern) => ({
      pattern,
      ...attempt(() => app.explain(pattern)),
    })),
    mermaid: app.toMermaid(),
    openapi: app.openapi(),
  };
}

// ── tests ───────────────────────────────────────────────────────────────────────────────────────

/** Structural equality that also holds array order and object key order. */
function expectSame(actual: unknown, expected: unknown, label: string): void {
  const plain = JSON.parse(JSON.stringify(actual));
  expect(plain, label).toEqual(expected);
  expect(JSON.stringify(plain), `${label} (key and array order)`).toBe(JSON.stringify(expected));
}

function loadExpected(): { local: Record<string, unknown>; mesh: Record<string, unknown> } {
  const record = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
    revision: string;
    data: { local: Record<string, unknown>; mesh: Record<string, unknown> };
  };
  expect(record.revision, 'expectations must come from the pre-radix revision').toBe(REVISION);
  return record.data;
}

describe('router introspection parity (CARD-09)', () => {
  beforeEach(() => {
    lookups.calls = 0;
  });

  it('local app: direct introspection, dev endpoints and lookups equal the ed47836 capture', async () => {
    const local = await captureLocal();
    const mesh = (await captureMesh()).result;

    if (CAPTURE_TO) {
      writeFileSync(CAPTURE_TO, `${JSON.stringify({ revision: REVISION, data: { local, mesh } }, null, 2)}\n`);
      return;
    }

    const expected = loadExpected();
    for (const key of ['direct', 'fetchDev', 'nodeDev', 'lookups'] as const)
      expectSame(local[key], expected.local[key], `local.${key}`);
    for (const key of ['before', 'after', 'dev', 'lookup'] as const)
      expectSame(mesh[key], expected.mesh[key], `mesh.${key}`);
  }, 30_000);

  it('explain() and inspect() take the first declaration of a pattern shared by several methods', () => {
    const app = createApp({ modules: [DocsModule] });
    expect(app.explain('/v1/docs/:id').method).toBe('DELETE');
    expect(app.inspect('/v1/docs/:id').at(-1)?.name).toBe('remove');
    // A concrete request path is never resolved against the patterns.
    expect(() => app.explain('/v1/docs/7')).toThrow('no route: /v1/docs/7');
    expect(() => app.inspect('/v1/docs/latest/')).toThrow('no route: /v1/docs/latest/');
  });

  it('dev endpoints agree with the direct API on app.fetch', async () => {
    const app = createApp({ modules: [DocsModule], devGraph: true, devOpenapi: true });
    const dev = await devEndpoints(viaFetch(app));
    expect(dev.openapi.body).toEqual(app.openapi());
    expect(dev.graphText.body).toBe(toMermaid(app.graph()));
    expect(dev.graphText.body).toBe(app.toMermaid());
    expect(dev.graphHtml.sha256).toBe(sha256(graphHtml(app.graph())));
  });

  it('dev endpoints agree with the direct API on a mesh teacup after ready()', async () => {
    const { result, anonymize, teacup } = await captureMesh();
    const anon = <T>(value: T): T => JSON.parse(anonymize(JSON.stringify(value)));
    expect(result.dev.openapi.body).toEqual(anon(teacup.openapi()));
    expect(result.dev.graphText.body).toBe(anonymize(teacup.toMermaid()));
    expect(result.dev.graphHtml.sha256).toBe(sha256(anonymize(graphHtml(teacup.graph()))));
    // Remote HTTP routes are served but stay out of routePlans-based introspection.
    expect(result.lookup).toMatchObject({ status: 200 });
    expect(result.after.graph.routes.map((route) => route.pattern)).toEqual(['/api/local/:id', '/api/local/who']);
    expect(Object.keys(result.after.openapi.paths)).not.toContain('/api/remote/ping');
  }, 30_000);

  it('introspection never consults the lookup index and keeps declaration order where the index ranks differently', async () => {
    const app = createApp({ modules: [DocsModule] });

    const cold = introspect(app);
    expect(lookups.calls, 'graph/explain/inspect/openapi must not call the router lookup').toBe(0);

    // Build and exercise the index. The ranked lookup answers `/latest` with the static route and
    // `/7` with the param route, although `rest` is declared before both.
    const served = await lookupsThrough(app);
    expect(lookups.calls).toBeGreaterThan(0);
    expect(JSON.parse(served[0].body)).toEqual({ id: 'latest' });
    expect(JSON.parse(served[1].body)).toEqual({ id: 'get', param: '7' });

    const calls = lookups.calls;
    const warm = introspect(app);
    expect(lookups.calls, 'introspection after the index exists still does no lookup').toBe(calls);
    expectSame(warm, cold, 'introspection before vs after the index was built');

    // Declaration order, not rank order.
    const graph = app.graph();
    expect(graph.routes.map((route) => route.chain.at(-1))).toEqual(DECLARED_HANDLERS);
    expect(Object.keys(app.openapi().paths)).toEqual([
      '/v1/docs/{id}',
      '/v1/docs/{rest}',
      '/v1/docs/latest',
      '/v1/docs/events',
    ]);
    expect(Object.keys(app.openapi().paths['/v1/docs/{id}'])).toEqual(['delete', 'get']);
  });
});
