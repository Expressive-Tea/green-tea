import 'reflect-metadata';
import { expect, test, describe, it } from 'vitest';
import {
  needs,
  ctx,
  param,
  query,
  body,
  headers,
  header,
  inbound,
  abort,
  getArgs,
  getHandlerNeeds,
  resolveArgs,
} from '../src/params';
import { ValidationError } from '../src/signals';

class Ctl {
  handler(
    @needs('user') _user: unknown,
    @param('id') _id: unknown,
    @query() _q: unknown,
    @query(['a', 'b']) _sub: unknown,
    @ctx() _c: unknown,
  ) {
    return null;
  }
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

test('resolveArgs builds positional args from context', async () => {
  const context = {
    user: { id: 'u1' },
    params: { id: '7' },
    query: { a: '1', b: '2', c: '3' },
  };
  const args = await resolveArgs(getArgs(Ctl, 'handler'), context);
  expect(args[0]).toEqual({ id: 'u1' });
  expect(args[1]).toBe('7');
  expect(args[2]).toEqual({ a: '1', b: '2', c: '3' });
  expect(args[3]).toEqual({ a: '1', b: '2' });
  expect(args[4]).toBe(context);
});

test('a handler with no arg decorators resolves to no args', async () => {
  class Bare {
    ping() {
      return 1;
    }
  }
  expect(await resolveArgs(getArgs(Bare, 'ping'), {})).toEqual([]);
});

describe('@inbound / @abort', () => {
  it('resolves inbound and abort from reserved context keys, not as bags', async () => {
    class Ctl {
      handle(@inbound() inc: AsyncIterable<unknown>, @abort() sig: AbortSignal) {
        return [inc, sig];
      }
    }
    const specs = getArgs(Ctl, 'handle');
    const ac = new AbortController();
    const inc = (async function* () {})();
    const args = await resolveArgs(specs, { inbound: inc, abort: ac.signal });
    expect(args[0]).toBe(inc);
    expect(args[1]).toBe(ac.signal);
  });

  it('inbound/abort do not count as graph needs', () => {
    class Ctl {
      handle(@inbound() _i: AsyncIterable<unknown>, @abort() _a: AbortSignal) {}
    }
    expect(getHandlerNeeds(getArgs(Ctl, 'handle'))).toEqual([]);
  });
});

describe('@headers / @header', () => {
  const reqHeaders = { authorization: 'Bearer t0ken', 'x-trace': 'abc', 'x-count': '5' };

  it('@header(name) and @headers(name) both pick a single header', async () => {
    class Ctl {
      handle(@header('authorization') _auth: string, @headers('x-trace') _trace: string) {}
    }
    const args = await resolveArgs(getArgs(Ctl, 'handle'), { headers: reqHeaders });
    expect(args[0]).toBe('Bearer t0ken');
    expect(args[1]).toBe('abc');
  });

  it('@headers() returns the whole bag and @headers([...]) picks several', async () => {
    class Ctl {
      handle(@headers() _all: unknown, @headers(['authorization', 'x-trace']) _some: unknown) {}
    }
    const args = await resolveArgs(getArgs(Ctl, 'handle'), { headers: reqHeaders });
    expect(args[0]).toEqual(reqHeaders);
    expect(args[1]).toEqual({ authorization: 'Bearer t0ken', 'x-trace': 'abc' });
  });

  it('@header(name, schema) validates the picked header', async () => {
    class Ctl {
      handle(@header('x-count', numFromStr) _count: number) {}
    }
    const args = await resolveArgs(getArgs(Ctl, 'handle'), { headers: reqHeaders });
    expect(args[0]).toBe(5);
  });
});

const numFromStr = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (v: unknown) => {
      const n = Number(v);
      return Number.isNaN(n) ? { issues: [{ message: 'not a number', path: ['n'] }] } : { value: n };
    },
  },
};
const asyncSchema = {
  '~standard': { version: 1 as const, vendor: 'test', validate: async (v: unknown) => ({ value: `async:${v}` }) },
};

describe('resolveArgs validation', () => {
  it('valid: substitutes the parsed/coerced value; ctx source untouched', async () => {
    class C {
      m(@query(numFromStr) _q: number) {}
    }
    const specs = getArgs(C, 'm');
    const ctx: any = { query: '42' };
    const args = await resolveArgs(specs, ctx);
    expect(args[0]).toBe(42);
    expect(ctx.query).toBe('42');
  });
  it('invalid: throws ValidationError with source', async () => {
    class C {
      m(@body(numFromStr) _b: number) {}
    }
    const specs = getArgs(C, 'm');
    await expect(resolveArgs(specs, { body: 'nope' })).rejects.toBeInstanceOf(ValidationError);
    await resolveArgs(specs, { body: 'nope' }).catch((e) => {
      expect(e.source).toBe('body');
      expect(e.issues[0].message).toBe('not a number');
    });
  });
  it('async schema is awaited', async () => {
    class C {
      m(@body(asyncSchema) _b: string) {}
    }
    const args = await resolveArgs(getArgs(C, 'm'), { body: 'x' });
    expect(args[0]).toBe('async:x');
  });
  it('@param(name, schema) validates the named param (slot-2 schema)', async () => {
    class C {
      m(@param('id', numFromStr) _id: number) {}
    }
    const args = await resolveArgs(getArgs(C, 'm'), { params: { id: '7' } });
    expect(args[0]).toBe(7);
  });
  it('non-schema decorators unchanged: @body("key"), @body(), @query(["a","b"])', async () => {
    class C {
      m(@body('x') _x: any, @body() _b: any, @query(['a', 'b']) _q: any) {}
    }
    const args = await resolveArgs(getArgs(C, 'm'), { body: { x: 1, y: 2 }, query: { a: 'A', b: 'B', c: 'C' } });
    expect(args[0]).toBe(1);
    expect(args[1]).toEqual({ x: 1, y: 2 });
    expect(args[2]).toEqual({ a: 'A', b: 'B' });
  });
  it('decoration-time guard: a non-schema object throws', () => {
    expect(() => {
      class C {
        m(@body({} as any) _b: any) {}
      }
      return C;
    }).toThrow();
  });
});
