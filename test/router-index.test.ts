/**
 * The radix index's own seams, which the frozen parity corpus (test/router-parity/) cannot reach:
 *
 * - The local/remote split. The corpus drives the matcher with flat arrays, so every scenario lands
 *   in the local tree; only the app-level mesh captures reach the remote one. Here every frozen
 *   scenario is replayed with its declarations spread across both trees, and must still answer
 *   exactly as the oracle does on the same flat array.
 * - Index lifetime: an array that changes length after its index was built is never served stale.
 */
import { describe, it, expect } from 'vitest';
import * as live from '../src/http/router';
import type { RouteDef } from '../src/http/types';
import * as oracle from './router-parity/oracle';
import { runScenario, type MatcherImpl, type Scenario } from './router-parity/matcher';
import { HAND_SCENARIOS, OWNER_SCENARIOS } from './router-parity/cases';
import { generateScenarios, generateScenariosV2 } from './router-parity/generator';

const SCENARIOS: Scenario[] = [...HAND_SCENARIOS, ...OWNER_SCENARIOS, ...generateScenarios(), ...generateScenariosV2()];

/** Which positions of the declaration array go to the remote tree. */
const SPLITS: Record<string, (index: number, length: number) => boolean> = {
  'all remote': () => true,
  'second half remote': (index, length) => index >= length / 2,
  'odd positions remote': (index) => index % 2 === 1,
  // Not a shape mesh produces (remote routes are spliced after local ones), but the tie rule is
  // array order either way, so the answer must not depend on it.
  'first half remote': (index, length) => index < length / 2,
};

/** The live router, with some declarations marked remote before the first lookup builds the index. */
function splitImpl(isRemote: (index: number, length: number) => boolean): MatcherImpl {
  const mark = (routes: RouteDef[]): RouteDef[] => {
    routes.forEach((route, index) => isRemote(index, routes.length) && live.markRemoteRoute(route));
    return routes;
  };
  return {
    normalizeRequestPath: live.normalizeRequestPath,
    matchRoute: (routes, method, path) => live.matchRoute(mark(routes), method, path),
    resolveRoute: (routes, method, path) => live.resolveRoute(mark(routes), method, path),
    allowedMethods: (routes, path) => live.allowedMethods(mark(routes), path),
  };
}

function route(method: string, pattern: string, transport: RouteDef['transport'] = 'buffer'): RouteDef {
  return { method, pattern, transport, handler: async () => ({ status: 200, headers: {}, body: pattern }) };
}

describe('radix index: local and remote trees', () => {
  for (const [name, isRemote] of Object.entries(SPLITS)) {
    it(`answers every frozen scenario like the flat oracle — ${name}`, () => {
      const impl = splitImpl(isRemote);
      for (const scenario of SCENARIOS) {
        expect(runScenario(impl, scenario), scenario.id).toEqual(runScenario(oracle, scenario));
      }
    });
  }

  it('lets a remote static route outrank a local param route, and a local twin win a tie', () => {
    const localParam = route('GET', '/items/:id');
    const localTwin = route('GET', '/items/special');
    const remoteStatic = live.markRemoteRoute(route('GET', '/items/special'));
    const remoteOnly = live.markRemoteRoute(route('GET', '/items/other'));

    expect(live.matchRoute([localParam, remoteStatic, remoteOnly], 'GET', '/items/other')?.def).toBe(remoteOnly);
    expect(live.matchRoute([localParam, remoteStatic], 'GET', '/items/special')?.def).toBe(remoteStatic);
    expect(live.matchRoute([localParam, localTwin, remoteStatic], 'GET', '/items/special')?.def).toBe(localTwin);
  });

  it('breaks a cross-tree tie by array position, so a later dev route never shadows a remote one', () => {
    const remote = live.markRemoteRoute(route('GET', '/__dev'));
    const dev = route('GET', '/__dev');
    expect(live.matchRoute([remote, dev], 'GET', '/__dev')?.def).toBe(remote);
  });

  it('builds Allow and implicit HEAD over the union of both trees', () => {
    const local = route('POST', '/a/:id');
    const remoteGet = live.markRemoteRoute(route('GET', '/a/:id'));
    const routes = [local, remoteGet];

    expect(live.allowedMethods(routes, '/a/1')).toEqual(['GET', 'HEAD', 'POST', 'OPTIONS']);
    expect(live.resolveRoute(routes, 'HEAD', '/a/1')).toMatchObject({ def: remoteGet, implicitHead: true });
  });

  it('passes over a higher-ranked streaming GET in one tree for a buffered GET in the other', () => {
    const stream = route('GET', '/s/live', 'sse');
    const buffered = live.markRemoteRoute(route('GET', '/s/:name'));
    expect(live.resolveRoute([stream, buffered], 'HEAD', '/s/live')).toMatchObject({
      def: buffered,
      params: { name: 'live' },
      implicitHead: true,
    });
  });
});

describe('radix index: lifetime', () => {
  it('rebuilds when the array it was built from changes length', () => {
    const routes = [route('GET', '/a')];
    expect(live.matchRoute(routes, 'GET', '/b')).toBeUndefined();

    const added = route('GET', '/b');
    routes.push(added);
    expect(live.matchRoute(routes, 'GET', '/b')?.def).toBe(added);
    expect(live.allowedMethods(routes, '/b')).toEqual(['GET', 'HEAD', 'OPTIONS']);

    routes.pop();
    expect(live.matchRoute(routes, 'GET', '/b')).toBeUndefined();
  });
});
