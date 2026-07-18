import { describe, it, expect } from 'vitest';
import { matchPattern, matchRoute, allowedMethods } from '../src/http/router';
import type { RouteDef } from '../src/http/types';

const route = (method: string, pattern: string): RouteDef => ({
  method,
  pattern,
  transport: 'buffer',
  handler: async () => ({ status: 200, headers: {}, body: '' }),
});

describe('matchPattern', () => {
  it('matches static and :param segments, decoding params', () => {
    expect(matchPattern('/users/:id', '/users/a%20b')).toEqual({ id: 'a b' });
    expect(matchPattern('/users/:id', '/users')).toBeUndefined();
    expect(matchPattern('/users', '/users/1')).toBeUndefined();
  });

  it(':name* captures the rest of the path, slashes included', () => {
    expect(matchPattern('/files/:path*', '/files/img/2026/logo.png')).toEqual({ path: 'img/2026/logo.png' });
    expect(matchPattern('/files/:path*', '/files/a%2Fb')).toEqual({ path: 'a/b' });
  });

  it(':name* matches zero remaining segments as an empty string', () => {
    expect(matchPattern('/files/:path*', '/files')).toEqual({ path: '' });
  });
});

describe('matchRoute precedence', () => {
  it('static beats :param beats catch-all regardless of registration order', () => {
    const routes = [route('GET', '/a/:rest*'), route('GET', '/a/:id'), route('GET', '/a/b')];
    expect(matchRoute(routes, 'GET', '/a/b')?.def.pattern).toBe('/a/b');
    expect(matchRoute(routes, 'GET', '/a/x')?.def.pattern).toBe('/a/:id');
    expect(matchRoute(routes, 'GET', '/a/x/y')?.def.pattern).toBe('/a/:rest*');
  });

  it('returns undefined when no pattern matches the path', () => {
    expect(matchRoute([route('GET', '/a')], 'GET', '/b')).toBeUndefined();
  });

  it('does not match a route registered under a different method', () => {
    expect(matchRoute([route('POST', '/a')], 'GET', '/a')).toBeUndefined();
  });
});

describe('allowedMethods (405 support)', () => {
  it('lists distinct methods whose pattern matches the path', () => {
    const routes = [route('GET', '/a'), route('POST', '/a'), route('GET', '/b')];
    expect(allowedMethods(routes, '/a').sort()).toEqual(['GET', 'POST']);
    expect(allowedMethods(routes, '/nope')).toEqual([]);
  });
});
