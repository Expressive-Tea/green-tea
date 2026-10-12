/**
 * Misses do not recompile (FPRD-001 CARD-10, #109).
 *
 * The linear matcher answered every 404, 405 and automatic OPTIONS by running `compilePattern` over
 * the whole table. The radix index compiles each pattern once, when the index for a route array is
 * built. These tests warm that index, then send repeated misses through the router functions and
 * through `buildFetch` / `app.fetch`, and assert that neither `compilePattern` nor the index build
 * runs again, while status and `Allow` stay correct.
 *
 * `compilePattern` is called inside `router.ts`, where a spy on the module export cannot see it, so
 * the router keeps two internal counters (`routerSeamCounts`) for this purpose.
 */
import { describe, it, expect } from 'vitest';
import { allowedMethods, resolveRoute, routerSeamCounts } from '../src/http/router';
import type { RouteDef } from '../src/http/types';
import { buildFetch } from '../src/http/web';
import { createApp, Route, Get, Post, Module } from '../src/index';

const REPEATS = 50;

function route(method: string, pattern: string): RouteDef {
  return { method, pattern, transport: 'buffer', handler: async () => ({ status: 200, headers: {}, body: pattern }) };
}

/** The bench generator's shapes: statics, params, constraints and catch-alls, 100 routes in all. */
function table(): RouteDef[] {
  const routes: RouteDef[] = [];
  for (let k = 0; routes.length < 98; k++) {
    routes.push(
      route('GET', `/res${k}/items`),
      route('POST', `/res${k}/items`),
      route('GET', `/res${k}/items/:id`),
      route('PUT', `/res${k}/items/:id(\\d+)`),
      route('GET', `/res${k}/files/:path*`),
    );
  }
  routes.length = 98;
  routes.push(route('GET', '/static/target/leaf'), route('GET', '/late/:group/:id'));
  return routes;
}

/** Runs `misses` once to build and warm the index, then `REPEATS` more times; returns the seam calls made by the repeats. */
async function callsDuringRepeats(
  misses: () => Promise<void> | void,
): Promise<{ compilePattern: number; indexBuilds: number }> {
  await misses();
  const before = routerSeamCounts();
  for (let i = 0; i < REPEATS; i++) await misses();
  const after = routerSeamCounts();
  return {
    compilePattern: after.compilePattern - before.compilePattern,
    indexBuilds: after.indexBuilds - before.indexBuilds,
  };
}

describe('misses after the index is built', () => {
  it('counts the build itself: one index build and one compilePattern call per route', () => {
    const routes = table();
    const before = routerSeamCounts();
    resolveRoute(routes, 'GET', '/nowhere/at/all');
    const after = routerSeamCounts();
    // Proves the counters observe the seam, so the zeros below are not vacuous.
    expect(after.indexBuilds - before.indexBuilds).toBe(1);
    expect(after.compilePattern - before.compilePattern).toBe(routes.length);
  });

  it('router functions: 404, 405 and OPTIONS lookups compile nothing and rebuild nothing', async () => {
    const routes = table();
    const calls = await callsDuringRepeats(() => {
      // 404: no route matches the path.
      expect(resolveRoute(routes, 'GET', '/nowhere/at/all')).toBeUndefined();
      expect(allowedMethods(routes, '/nowhere/at/all')).toEqual([]);
      // 405: the path matches, the method does not.
      expect(resolveRoute(routes, 'DELETE', '/static/target/leaf')).toBeUndefined();
      expect(allowedMethods(routes, '/static/target/leaf')).toEqual(['GET', 'HEAD', 'OPTIONS']);
      expect(resolveRoute(routes, 'DELETE', '/res3/items/7')).toBeUndefined();
      expect(allowedMethods(routes, '/res3/items/7')).toEqual(['GET', 'HEAD', 'PUT', 'OPTIONS']);
      // Automatic OPTIONS: no OPTIONS route, so dispatch answers from allowedMethods.
      expect(resolveRoute(routes, 'OPTIONS', '/res3/items')).toBeUndefined();
      expect(allowedMethods(routes, '/res3/items')).toEqual(['GET', 'HEAD', 'POST', 'OPTIONS']);
    });
    expect(calls).toEqual({ compilePattern: 0, indexBuilds: 0 });
  });

  it('buildFetch: repeated 404, 405 and automatic OPTIONS keep status and Allow, with no recompilation', async () => {
    const fetch = buildFetch(table(), undefined);
    const calls = await callsDuringRepeats(async () => {
      const notFound = await fetch(new Request('http://x/nowhere/at/all'));
      expect(notFound.status).toBe(404);
      expect(notFound.headers.get('allow')).toBeNull();

      const notAllowed = await fetch(new Request('http://x/res3/items/7', { method: 'DELETE' }));
      expect(notAllowed.status).toBe(405);
      expect(notAllowed.headers.get('allow')).toBe('GET, HEAD, PUT, OPTIONS');

      const options = await fetch(new Request('http://x/res3/items', { method: 'OPTIONS' }));
      expect(options.status).toBe(204);
      expect(options.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS');
    });
    expect(calls).toEqual({ compilePattern: 0, indexBuilds: 0 });
  });

  it('app.fetch: repeated 404, 405 and automatic OPTIONS keep status and Allow, with no recompilation', async () => {
    @Route('/things')
    class Things {
      @Get('/') list() {
        return [];
      }
      @Post('/') create() {
        return {};
      }
      @Get('/:id') one() {
        return {};
      }
    }
    @Module({ mountpoint: '/api', controllers: [Things] })
    class Api {}
    const app = createApp({ modules: [Api] });

    const calls = await callsDuringRepeats(async () => {
      const notFound = await app.fetch(new Request('http://x/api/nowhere'));
      expect(notFound.status).toBe(404);

      const notAllowed = await app.fetch(new Request('http://x/api/things/1', { method: 'DELETE' }));
      expect(notAllowed.status).toBe(405);
      expect(notAllowed.headers.get('allow')).toBe('GET, HEAD, OPTIONS');

      const options = await app.fetch(new Request('http://x/api/things', { method: 'OPTIONS' }));
      expect(options.status).toBe(204);
      expect(options.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS');
    });
    expect(calls).toEqual({ compilePattern: 0, indexBuilds: 0 });
  });
});
