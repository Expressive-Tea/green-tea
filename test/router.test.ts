import { describe, it, expect } from 'vitest';
import {
  compilePattern,
  matchPattern,
  matchRoute,
  resolveRoute,
  allowedMethods,
  normalizeRequestPath,
} from '../src/http/router';
import type { RouteDef } from '../src/http/types';

const route = (method: string, pattern: string): RouteDef => ({
  method,
  pattern,
  transport: 'buffer',
  handler: async () => ({ status: 200, headers: {}, body: '' }),
});

describe('matchPattern', () => {
  it('matches the root pattern only at root', () => {
    expect(matchPattern('/', '/')).toEqual({});
    expect(matchPattern('/', '/users')).toBeUndefined();
  });

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

  it('matches safe constraints against the complete decoded segment', () => {
    expect(matchPattern('/users/:id(\\d+)', '/users/42')).toEqual({ id: '42' });
    expect(matchPattern('/users/:id(\\d+)', '/users/42x')).toBeUndefined();
    expect(matchPattern('/posts/:slug([a-z0-9_-]+)', '/posts/green-tea_26')).toEqual({ slug: 'green-tea_26' });
    expect(matchPattern('/build/:version(\\d{2}\\.\\d{1,2})', '/build/26.8')).toEqual({ version: '26.8' });
  });
});

describe('compilePattern', () => {
  it('records a stable shape independent of parameter names', () => {
    expect(compilePattern('/users/:id').shape).toBe(compilePattern('/users/:name').shape);
    expect(compilePattern('/users/:id(\\d+)').shape).not.toBe(compilePattern('/users/:id').shape);
  });

  it.each([
    '/files/:rest*/tail',
    '/users/:',
    '/users/:id/:id',
    '/users//:id',
    '/users/:id((a+)+)',
    '/users/:id((?=a)a)',
    '/users/:id(\\1)',
    '/users/:id(a|b)',
  ])('rejects invalid or unsafe pattern %s', (pattern) => {
    expect(() => compilePattern(pattern)).toThrow(/invalid route pattern|unsafe route constraint/);
  });
});

describe('normalizeRequestPath', () => {
  it('treats one trailing slash as equivalent and preserves root', () => {
    expect(normalizeRequestPath('/users')).toBe('/users');
    expect(normalizeRequestPath('/users/')).toBe('/users');
    expect(normalizeRequestPath('/')).toBe('/');
  });

  it('rejects repeated slashes and malformed percent encoding', () => {
    expect(() => normalizeRequestPath('/users//42')).toThrow(/repeated slash/);
    expect(() => normalizeRequestPath('/users/%E0%A4%A')).toThrow(/malformed path encoding/);
  });
});

describe('matchRoute precedence', () => {
  it('static beats :param beats catch-all regardless of registration order', () => {
    const routes = [route('GET', '/a/:rest*'), route('GET', '/a/:id'), route('GET', '/a/b')];
    expect(matchRoute(routes, 'GET', '/a/b')?.def.pattern).toBe('/a/b');
    expect(matchRoute(routes, 'GET', '/a/x')?.def.pattern).toBe('/a/:id');
    expect(matchRoute(routes, 'GET', '/a/x/y')?.def.pattern).toBe('/a/:rest*');
  });

  it('constrained params beat unconstrained params regardless of registration order', () => {
    const routes = [route('GET', '/users/:value'), route('GET', '/users/:id(\\d+)')];
    expect(matchRoute(routes, 'GET', '/users/42')?.def.pattern).toBe('/users/:id(\\d+)');
    expect(matchRoute(routes, 'GET', '/users/diego')?.def.pattern).toBe('/users/:value');
  });

  it('returns undefined when no pattern matches the path', () => {
    expect(matchRoute([route('GET', '/a')], 'GET', '/b')).toBeUndefined();
  });

  it('does not match a route registered under a different method', () => {
    expect(matchRoute([route('POST', '/a')], 'GET', '/a')).toBeUndefined();
  });
});

describe('allowedMethods (405 support)', () => {
  it('lists methods in canonical order with implicit HEAD and OPTIONS', () => {
    const routes = [route('POST', '/a'), route('GET', '/a'), route('GET', '/b')];
    expect(allowedMethods(routes, '/a')).toEqual(['GET', 'HEAD', 'POST', 'OPTIONS']);
    expect(allowedMethods(routes, '/nope')).toEqual([]);
  });
});

describe('resolveRoute', () => {
  it('prefers explicit HEAD and otherwise falls back to buffered GET', () => {
    const explicit = [route('GET', '/a'), route('HEAD', '/a')];
    expect(resolveRoute(explicit, 'HEAD', '/a')).toMatchObject({ implicitHead: false, def: { method: 'HEAD' } });

    const fallback = resolveRoute([route('GET', '/a')], 'HEAD', '/a');
    expect(fallback).toMatchObject({ implicitHead: true, def: { method: 'GET' } });
  });

  it('does not use a streaming GET as implicit HEAD', () => {
    const streaming = { ...route('GET', '/a'), transport: 'sse' as const };
    expect(resolveRoute([streaming], 'HEAD', '/a')).toBeUndefined();
  });
});
