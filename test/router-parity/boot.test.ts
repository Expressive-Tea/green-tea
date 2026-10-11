/**
 * Boot-time rejection parity: invalid patterns, local ambiguity and mesh route splicing. These are
 * not inputs to the differential matcher — a pattern that fails here never reaches a lookup — so
 * they are frozen as their own expected-error fixture: the rejection point (pattern compile, app
 * construction, mesh `ready()`), the error class and the exact message.
 */
import 'reflect-metadata';
import type { AddressInfo } from 'net';
import { describe, it } from 'vitest';
import { createApp, Route, Get, Post, Sse, Ws, Module, param } from '../../src/index';
import type { RouteDecorator } from '../../src/metadata';
import type { Logger } from '../../src/logger';
import * as live from '../../src/http/router';
import * as oracle from './oracle';
import { errorOutcome, type ErrorOutcome } from './matcher';
import { frozen, expectFrozenEqual } from './frozen';

const PATTERNS = [
  '/',
  '/users/:id',
  '/users/:id(\\d+)',
  '/files/:rest*',
  '/:rest*',
  '/t/',
  '/café',
  '/build/:version(\\d{2}\\.\\d{1,2})',
  '/x/:id/:id',
  '/x/:id/:rest*/tail',
  '/x/:rest*/:rest*',
  '/x/:',
  '/x/:1x',
  '/x//y',
  'x',
  '',
  '/x/:id((a+)+)',
  '/x/:id((?=a)a)',
  '/x/:id(\\1)',
  '/x/:id(a|b)',
  '/x/:id(\\d+\\w+)',
  '/x/:id(\\d{5,2})',
  '/x/:id(\\d{1,4096})',
  '/x/:id(\\d+',
  '/x/:id()',
  `/x/:id(${'a'.repeat(129)})`,
];

type PatternOutcome = { pattern: string; shape: string } | { pattern: string; error: ErrorOutcome };

function compileAll(compile: (pattern: string) => { shape: string }): PatternOutcome[] {
  return PATTERNS.map((pattern) => {
    try {
      return { pattern, shape: compile(pattern).shape };
    } catch (error) {
      return { pattern, error: errorOutcome(error) };
    }
  });
}

type Decl = [decorator: RouteDecorator, path: string];

/** One controller per case, its handlers declared in the given order (decorators applied by hand). */
function moduleWith(decls: Decl[]) {
  class ParityBoot {}
  decls.forEach(([decorator, path], index) => {
    const name = `h${index}`;
    Object.defineProperty(ParityBoot.prototype, name, {
      value: () => (async function* () {})(),
      configurable: true,
    });
    decorator(path)(ParityBoot.prototype, name, Object.getOwnPropertyDescriptor(ParityBoot.prototype, name)!);
  });
  Route('/')(ParityBoot);
  class ParityBootModule {}
  Module({ mountpoint: '/', controllers: [ParityBoot] })(ParityBootModule);
  return ParityBootModule;
}

const APP_CASES: Array<{ id: string; decls: Decl[] }> = [
  { id: 'B01-duplicate-param', decls: [[Get, '/x/:id/:id']] },
  { id: 'B02-nonfinal-catch-all', decls: [[Get, '/x/:rest*/tail']] },
  { id: 'B03-nested-quantifier', decls: [[Get, '/x/:id((a+)+)']] },
  { id: 'B04-alternation', decls: [[Get, '/x/:id(a|b)']] },
  { id: 'B05-adjacent-unbounded', decls: [[Get, '/x/:id(\\d+\\w+)']] },
  { id: 'B06-inverted-quantifier', decls: [[Get, '/x/:id(\\d{5,2})']] },
  { id: 'B07-invalid-param-name', decls: [[Get, '/x/:1x']] },
  { id: 'B08-malformed-constraint', decls: [[Get, '/x/:id(\\d+']] },
  {
    id: 'B09-same-shape-plain',
    decls: [
      [Get, '/users/:id'],
      [Get, '/users/:name'],
    ],
  },
  {
    id: 'B10-same-shape-constrained',
    decls: [
      [Get, '/c/:a(\\d+)'],
      [Get, '/c/:b(\\d+)'],
    ],
  },
  {
    id: 'B11-trailing-slash-twin',
    decls: [
      [Get, '/t'],
      [Get, '/t/'],
    ],
  },
  {
    id: 'B12-get-and-ws-same-path',
    decls: [
      [Get, '/live'],
      [Ws, '/live'],
    ],
  },
  {
    id: 'B13-get-and-sse-same-path',
    decls: [
      [Get, '/feed'],
      [Sse, '/feed'],
    ],
  },
  {
    id: 'B14-ws-same-shape',
    decls: [
      [Ws, '/w/:a'],
      [Ws, '/w/:b'],
    ],
  },
  {
    id: 'B15-ok-same-shape-different-methods',
    decls: [
      [Get, '/users/:id'],
      [Post, '/users/:name'],
    ],
  },
  {
    id: 'B16-ok-different-constraints',
    decls: [
      [Get, '/c/:a(\\d+)'],
      [Get, '/c/:b([a-z]+)'],
    ],
  },
  {
    id: 'B17-ok-static-and-param',
    decls: [
      [Get, '/users/me'],
      [Get, '/users/:id'],
    ],
  },
  {
    id: 'B18-ok-exact-and-catch-all',
    decls: [
      [Get, '/f'],
      [Get, '/f/:rest*'],
    ],
  },
];

const LABELS = new Map<RouteDecorator, string>([
  [Get, '@Get'],
  [Post, '@Post'],
  [Sse, '@Sse'],
  [Ws, '@Ws'],
]);

function bootAll() {
  return APP_CASES.map(({ id, decls }) => {
    const declarations = decls.map(([decorator, path]) => `${LABELS.get(decorator)}('${path}')`);
    try {
      createApp({ modules: [moduleWith(decls)] });
      return { id, declarations, ok: true };
    } catch (error) {
      return { id, declarations, error: errorOutcome(error) };
    }
  });
}

// ── mesh ────────────────────────────────────────────────────────────────────────────────────────

const SECRET = 'parity-secret';

@Route('/dup')
class DupCtl {
  @Get('/ping', { export: true }) ping() {
    return { from: 'teapot' };
  }
}
@Module({ mountpoint: '/api', controllers: [DupCtl] })
class DupTeapotModule {}

@Route('/shape')
class ShapeIdCtl {
  @Get('/:id', { export: true }) get(@param() p: Record<string, string>) {
    return { from: 'id', p };
  }
}
@Module({ mountpoint: '/api', controllers: [ShapeIdCtl] })
class ShapeIdTeapotModule {}

@Route('/shape')
class ShapeNameCtl {
  @Get('/:name', { export: true }) get(@param() p: Record<string, string>) {
    return { from: 'name', p };
  }
}
@Module({ mountpoint: '/api', controllers: [ShapeNameCtl] })
class ShapeNameTeapotModule {}

// Same method and shape as the teapot's export: the local route wins, with a warning.
@Route('/dup')
class ShadowCtl {
  @Get('/ping') local() {
    return { from: 'local' };
  }
}
@Module({ mountpoint: '/api', controllers: [ShadowCtl] })
class ShadowTeacupModule {}

// A different shape that overlaps the export: no warning, and lookup ranks across local and remote.
@Route('/dup')
class OverlapCtl {
  @Get('/:anything') local(@param() p: Record<string, string>) {
    return { from: 'local', p };
  }
}
@Module({ mountpoint: '/api', controllers: [OverlapCtl] })
class OverlapTeacupModule {}

@Route('/c')
class PlainCtl {
  @Get('/ok') ok() {
    return { from: 'teacup' };
  }
}
@Module({ mountpoint: '/', controllers: [PlainCtl] })
class PlainTeacupModule {}

type Ctor = new (...args: unknown[]) => unknown;

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  return { logger: { debug: noop, info: noop, error: noop, warn: (m) => warnings.push(m) }, warnings };
}

/** Starts one teapot per module and returns their control URLs plus a function that hides the ports. */
async function teapots(modules: Ctor[]) {
  const apps = modules.map((module) => createApp({ modules: [module], experimental: true, mesh: { secret: SECRET } }));
  const servers = await Promise.all(apps.map((app) => app.listen(0)));
  const urls = servers.map((s) => `ws://127.0.0.1:${(s.address() as AddressInfo).port}/__mesh__/control`);
  const anonymize = (text: string) => urls.reduce((out, url, i) => out.split(url).join(`<teapot${i + 1}>`), text);
  const close = () => Promise.all(apps.map((app) => app.close()));
  return { urls, anonymize, close };
}

async function meshCase(id: string, teacupModule: Ctor, teapotModules: Ctor[], requests: string[]) {
  const pots = await teapots(teapotModules);
  const { logger, warnings } = recordingLogger();
  const teacup = createApp({
    modules: [teacupModule],
    experimental: true,
    logger,
    mesh: { teapots: pots.urls.map((url) => ({ url, secret: SECRET })) },
  });

  try {
    await teacup.ready();
    const responses = [];
    for (const path of requests) {
      const res = await teacup.fetch(new Request(`http://parity.test${path}`));
      responses.push({ path, status: res.status, body: await res.text() });
    }
    const routing = warnings.filter((w) => w.includes('precedence')).map(pots.anonymize);
    return { id, ok: true, warnings: routing, responses };
  } catch (error) {
    const { name, message } = errorOutcome(error);
    return { id, error: { name, message: pots.anonymize(message) } };
  } finally {
    await teacup.close();
    await pots.close();
  }
}

async function meshAll() {
  return [
    await meshCase('M01-two-teapots-same-route', PlainTeacupModule, [DupTeapotModule, DupTeapotModule], []),
    await meshCase('M02-two-teapots-same-shape', PlainTeacupModule, [ShapeIdTeapotModule, ShapeNameTeapotModule], []),
    await meshCase('M03-local-same-shape-wins', ShadowTeacupModule, [DupTeapotModule], ['/api/dup/ping']),
    await meshCase('M04-unique-remote', PlainTeacupModule, [DupTeapotModule], ['/api/dup/ping', '/c/ok', '/api/nope']),
    await meshCase(
      'M05-remote-static-outranks-local-param',
      OverlapTeacupModule,
      [DupTeapotModule],
      ['/api/dup/ping', '/api/dup/x'],
    ),
  ];
}

describe('router parity: boot-time rejection', () => {
  it('pattern compilation (oracle and live compilePattern) equals the frozen capture', async () => {
    const expected = await frozen('boot-patterns', () => compileAll(live.compilePattern));
    expectFrozenEqual(compileAll(oracle.compilePattern), expected, 'oracle compilePattern');
    expectFrozenEqual(compileAll(live.compilePattern), expected, 'live compilePattern');
  });

  it('createApp route-table validation equals the frozen capture', async () => {
    const expected = await frozen('boot-app', bootAll);
    expectFrozenEqual(bootAll(), expected, 'createApp');
  });

  it('mesh route splicing equals the frozen capture', async () => {
    const expected = await frozen('boot-mesh', meshAll);
    expectFrozenEqual(await meshAll(), expected, 'mesh splice');
  }, 30_000);
});
