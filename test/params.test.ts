import 'reflect-metadata';
import { expect, test, describe, it } from 'vitest';
import { needs, ctx, param, query, inbound, abort, getArgs, getHandlerNeeds, resolveArgs } from '../src/params';

class Ctl {
  handler(
    @needs('user') _user: unknown,
    @param('id') _id: unknown,
    @query() _q: unknown,
    @query(['a', 'b']) _sub: unknown,
    @ctx() _c: unknown,
  ) { return null; }
}

test('getArgs returns specs sorted by parameter index', () => {
  const specs = getArgs(Ctl, 'handler');
  expect(specs.map((s) => [s.index, s.source, s.key ?? s.keys])).toEqual([
    [0, 'needs', 'user'],
    [1, 'params', 'id'],
    [2, 'query', undefined],
    [3, 'query', ['a', 'b']],
    [4, 'ctx', undefined],
  ]);
});

test('getHandlerNeeds extracts only @needs keys', () => {
  expect(getHandlerNeeds(getArgs(Ctl, 'handler'))).toEqual(['user']);
});

test('resolveArgs builds positional args from context', () => {
  const context = {
    user: { id: 'u1' },
    params: { id: '7' },
    query: { a: '1', b: '2', c: '3' },
  };
  const args = resolveArgs(getArgs(Ctl, 'handler'), context);
  expect(args[0]).toEqual({ id: 'u1' });
  expect(args[1]).toBe('7');
  expect(args[2]).toEqual({ a: '1', b: '2', c: '3' });
  expect(args[3]).toEqual({ a: '1', b: '2' });
  expect(args[4]).toBe(context);
});

test('a handler with no arg decorators resolves to no args', () => {
  class Bare { ping() { return 1; } }
  expect(resolveArgs(getArgs(Bare, 'ping'), {})).toEqual([]);
});

describe('@inbound / @abort', () => {
  it('resolves inbound and abort from reserved context keys, not as bags', () => {
    class Ctl { handle(@inbound() inc: AsyncIterable<unknown>, @abort() sig: AbortSignal) { return [inc, sig]; } }
    const specs = getArgs(Ctl, 'handle');
    const ac = new AbortController();
    const inc = (async function* () {})();
    const args = resolveArgs(specs, { inbound: inc, abort: ac.signal });
    expect(args[0]).toBe(inc);
    expect(args[1]).toBe(ac.signal);
  });

  it('inbound/abort do not count as graph needs', () => {
    class Ctl { handle(@inbound() _i: AsyncIterable<unknown>, @abort() _a: AbortSignal) {} }
    expect(getHandlerNeeds(getArgs(Ctl, 'handle'))).toEqual([]);
  });
});
