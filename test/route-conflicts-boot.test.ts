/**
 * CARD-13 (#127) through `createApp`: the card's test cases T1–T9, at boot, with the exact messages.
 * The decision procedure itself is covered in `route-conflicts.test.ts`.
 */
import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { createApp, Route, Get, Post, Ws, Stream, Module, param } from '../src/index';
import type { RouteDecorator } from '../src/metadata';

type Decl = [RouteDecorator, string];

/** One controller with a handler per declaration, `h0`, `h1`, … in order, each echoing its params. */
function moduleWith(decls: Decl[], options?: { export: boolean }) {
  class Routes {}

  decls.forEach(([decorator, path], index) => {
    const name = `h${index}`;
    Object.defineProperty(Routes.prototype, name, {
      value: (p: Record<string, string>) => ({ route: name, params: p }),
      configurable: true,
    });
    param()(Routes.prototype, name, 0);
    (options ? decorator(path, options) : decorator(path))(
      Routes.prototype,
      name,
      Object.getOwnPropertyDescriptor(Routes.prototype, name)!,
    );
  });

  Route('/')(Routes);
  class RoutesModule {}
  Module({ mountpoint: '/', controllers: [Routes] })(RoutesModule);
  return RoutesModule;
}

const boot = (decls: Decl[]) => createApp({ modules: [moduleWith(decls)] });
const bootError = (decls: Decl[]): string => {
  try {
    boot(decls);
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected the app to refuse to boot');
};

async function get(app: ReturnType<typeof createApp>, path: string) {
  const res = await app.fetch(new Request(`http://x${path}`));
  return res.json();
}

describe('CARD-13: constrained params that can never be reached, or tie with a sibling', () => {
  it('T1: GET /algo/:id + GET /algo/:a(.*) boots — `.` leaves line terminators to :id', async () => {
    // The card expected `:id` to be unreachable. It is not: without the `s` flag `.` excludes line
    // terminators, so a segment such as `%0A` fails `(.*)` and lands on `:id`. Refusing to boot would
    // claim something false about the router.
    const app = boot([
      [Get, '/algo/:id'],
      [Get, '/algo/:a(.*)'],
    ]);
    expect(await get(app, '/algo/x')).toEqual({ route: 'h1', params: { a: 'x' } });
    expect(await get(app, '/algo/%0A')).toEqual({ route: 'h0', params: { id: '\n' } });
  });

  it('T1 (every segment): GET /algo/:id + GET /algo/:a([^]*) fails, naming both', () => {
    expect(
      bootError([
        [Get, '/algo/:id'],
        [Get, '/algo/:a([^]*)'],
      ]),
    ).toBe(
      'unreachable route GET /algo/:id at Routes.h0: GET /algo/:a([^]*) at Routes.h1 matches every request it would, ' +
        'and wins each one — its constraint accepts every segment, and a constrained parameter outranks a plain one. ' +
        'Remove one of them, or narrow the constraint',
    );
  });

  it('T2: GET /u/:id(\\d+) + GET /u/:n(\\d{1,3}) fails with a witness', () => {
    expect(
      bootError([
        [Get, '/u/:id(\\d+)'],
        [Get, '/u/:n(\\d{1,3})'],
      ]),
    ).toBe(
      "ambiguous route GET /u/:n(\\d{1,3}) at Routes.h1 conflicts with GET /u/:id(\\d+) at Routes.h0: both match '0' " +
        '(GET /u/0), so only declaration order would choose between them — give the constraints disjoint languages, ' +
        'or merge the routes',
    );
  });

  it('T3: equivalent sources — GET /u/:id(\\d+) + GET /u/:id([0-9]+) fails', () => {
    expect(
      bootError([
        [Get, '/u/:id(\\d+)'],
        [Get, '/u/:id([0-9]+)'],
      ]),
    ).toMatch(
      /^ambiguous route GET \/u\/:id\(\[0-9\]\+\) at Routes\.h1 conflicts with GET \/u\/:id\(\\d\+\) .*both match '0'/,
    );
  });

  it('T4: GET /u/:id(\\d+) + GET /u/:slug boots, and routing is unchanged', async () => {
    for (const order of [
      [
        [Get, '/u/:id(\\d+)'],
        [Get, '/u/:slug'],
      ],
      [
        [Get, '/u/:slug'],
        [Get, '/u/:id(\\d+)'],
      ],
    ] as Decl[][]) {
      const app = boot(order);
      const idRoute = order[0][1].includes('(') ? 'h0' : 'h1';
      const slugRoute = idRoute === 'h0' ? 'h1' : 'h0';
      expect(await get(app, '/u/42')).toEqual({ route: idRoute, params: { id: '42' } });
      expect(await get(app, '/u/bob')).toEqual({ route: slugRoute, params: { slug: 'bob' } });
    }
  });

  it('T5: disjoint constraints — GET /u/:id(\\d+) + GET /u/:s([a-z]+) boots', () => {
    expect(() =>
      boot([
        [Get, '/u/:id(\\d+)'],
        [Get, '/u/:s([a-z]+)'],
      ]),
    ).not.toThrow();
  });

  it('T6: different methods — GET /u/:id(\\d+) + POST /u/:n(\\d{1,3}) boots', () => {
    expect(() =>
      boot([
        [Get, '/u/:id(\\d+)'],
        [Post, '/u/:n(\\d{1,3})'],
      ]),
    ).not.toThrow();
  });

  it('T7: WS /r/:id + WS /r/:a(.*) fails — WebSocket routes match in declaration order', () => {
    expect(
      bootError([
        [Ws, '/r/:id'],
        [Ws, '/r/:a(.*)'],
      ]),
    ).toBe(
      'unreachable route WS /r/:a(.*) at Routes.h1: WS /r/:id at Routes.h0 matches every request it would, and wins ' +
        'each one — WebSocket routes are matched in declaration order, and it is declared first. Remove one of them, ' +
        'or narrow the constraint',
    );
  });

  it('T7 (more): WS follows rule 2, and only its own table', () => {
    expect(
      bootError([
        [Ws, '/r/:id(\\d+)'],
        [Ws, '/r/:n(\\d{1,3})'],
      ]),
    ).toMatch(/^ambiguous route WS \/r\/:n.*both match '0' \(WebSocket \/r\/0\)/);
    // A WS route and an HTTP GET are different tables: an upgrade never reaches the HTTP route.
    expect(() =>
      boot([
        [Ws, '/r/:id'],
        [Get, '/r/:a([^]*)'],
      ]),
    ).not.toThrow();
    // `@Stream` (negotiate) is served from both tables, so it is checked under both precedences.
    expect(
      bootError([
        [Stream, '/s/:id'],
        [Ws, '/s/:a(\\d+)'],
      ]),
    ).toMatch(/^unreachable route WS \/s\/:a\(\\d\+\) at Routes\.h1: GET \/s\/:id at Routes\.h0/);
  });

  it('T9: {0,2048} against {0,2048} at boot — result and time', () => {
    const started = performance.now();
    expect(
      bootError([
        [Get, '/t/:a(\\d{0,2048})'],
        [Get, '/t/:b([0-9]{0,2048})'],
      ]),
    ).toMatch(/both match '0' \(GET \/t\/0\)/);
    expect(() =>
      boot([
        [Get, '/t/:a(\\d{0,2048})'],
        [Get, '/t/:b([a-z]{0,2048})'],
      ]),
    ).not.toThrow();
    expect(() =>
      boot([
        [Get, `/w/:a(${'\\d{0,2048}'.repeat(12)}a)`],
        [Get, `/w/:b(${'[0-9]{0,2048}'.repeat(9)}b)`],
      ]),
    ).not.toThrow();
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

// ── T8: mesh ─────────────────────────────────────────────────────────────────────────────────────

const SECRET = 'card-13-secret';
const controlUrl = (server: { address(): unknown }) =>
  `ws://127.0.0.1:${(server.address() as { port: number }).port}/__mesh__/control`;

async function teacupWith(teapots: Decl[][], local: Decl[] = [[Get, '/c/ok']]) {
  const servers = await Promise.all(
    teapots.map((decls) =>
      createApp({
        modules: [moduleWith(decls, { export: true })],
        experimental: true,
        mesh: { secret: SECRET },
      }).listen(0),
    ),
  );
  const teacup = createApp({
    modules: [moduleWith(local)],
    experimental: true,
    mesh: { teapots: servers.map((server) => ({ url: controlUrl(server), secret: SECRET })) },
  });
  return {
    teacup,
    urls: servers.map(controlUrl),
    close: async () => {
      await teacup.close();
      servers.forEach((server) => server.close());
    },
  };
}

describe('CARD-13 T8: the same check between remote siblings', () => {
  it("T8: two teapots exporting T2's pair refuse to boot the teacup", async () => {
    const { teacup, urls, close } = await teacupWith([[[Get, '/u/:id(\\d+)']], [[Get, '/u/:n(\\d{1,3})']]]);

    try {
      await expect(teacup.ready()).rejects.toThrow(
        `mesh: ambiguous remote route 'GET /u/:n(\\d{1,3})' from ${urls[1]} conflicts with 'GET /u/:id(\\d+)' ` +
          `from ${urls[0]}: both match '0' (GET /u/0) — green-tea will not choose one for you. ` +
          'Export only one of them, or give their constraints disjoint languages.',
      );
    } finally {
      await close();
    }
  });

  it('an unreachable remote sibling refuses to boot too', async () => {
    const { teacup, close } = await teacupWith([[[Get, '/v/:id']], [[Get, '/v/:a([^]+)']]]);

    try {
      await expect(teacup.ready()).rejects.toThrow(
        /^mesh: unreachable remote route 'GET \/v\/:id' from .*'GET \/v\/:a\(\[\^\]\+\)'/,
      );
    } finally {
      await close();
    }
  });

  it('a fallback pair across teapots boots and routes as before', async () => {
    const { teacup, close } = await teacupWith([[[Get, '/u/:id(\\d+)']], [[Get, '/u/:slug']]]);

    try {
      expect(await get(teacup, '/u/42')).toEqual({ route: 'h0', params: { id: '42' } });
      expect(await get(teacup, '/u/bob')).toEqual({ route: 'h0', params: { slug: 'bob' } });
    } finally {
      await close();
    }
  });

  it('local against remote keeps the deliberate local override: no new error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { teacup, close } = await teacupWith([[[Get, '/u/:n(\\d{1,3})']]], [[Get, '/u/:id(\\d+)']]);

    try {
      expect(await get(teacup, '/u/7')).toEqual({ route: 'h0', params: { id: '7' } });
    } finally {
      warn.mockRestore();
      await close();
    }
  });
});
