import { describe, expect, it, test, vi } from 'vitest';
import { runPipeline, runSteps, isStreamResult } from '../src/pipeline';
import { Bus } from '../src/bus';
import { JsonTransformer } from '../src/transformers';
import { Unauthorized } from '../src/signals';

const base = { transformer: JsonTransformer, seed: { req: { token: 'abc' } } };

test('runs steps, accumulates ctx, transforms handler return', async () => {
  const bus = new Bus();
  const res = await runPipeline({
    ...base, bus, transport: 'buffer',
    steps: [{ name: 'auth', origin: 'mod', run: (ctx) => ({ user: ctx.req.token }) }],
    handler: (ctx) => ({ user: ctx.user }),
  });
  expect(isStreamResult(res)).toBe(false);
  if (!isStreamResult(res)) {
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ user: 'abc' });
  }
});

test('a thrown HttpError short-circuits to an error response', async () => {
  const bus = new Bus();
  const res = await runPipeline({
    ...base, bus, transport: 'buffer',
    steps: [{ name: 'auth', origin: 'mod', run: () => { throw new Unauthorized('no'); } }],
    handler: () => ({ never: true }),
  });
  expect(isStreamResult(res)).toBe(false);
  if (!isStreamResult(res)) expect(res.status).toBe(401);
});

test('emits enter/leave/error lifecycle events', async () => {
  const bus = new Bus();
  const enter = vi.fn(); const error = vi.fn();
  bus.on('request:step:enter', enter);
  bus.on('request:step:error', error);
  await runPipeline({
    ...base, bus, transport: 'buffer',
    steps: [{ name: 'boom', origin: 'mod', run: () => { throw new Unauthorized(); } }],
    handler: () => ({}),
  });
  expect(enter).toHaveBeenCalledWith(expect.objectContaining({ name: 'boom' }));
  expect(error).toHaveBeenCalled();
});

describe('runPipeline streaming', () => {
  const bus = new Bus();
  const noTransform = (v: unknown) => ({ body: String(v) });

  it('returns a StreamResult when the handler returns an AsyncIterable (transformer bypassed)', async () => {
    async function* gen() { yield 1; yield 2; }
    const res = await runPipeline({ steps: [], handler: () => gen(), transformer: noTransform, seed: {}, bus, transport: 'sse' });
    expect(isStreamResult(res)).toBe(true);
    if (isStreamResult(res)) {
      const out: unknown[] = [];
      for await (const v of res.stream) out.push(v);
      expect(out).toEqual([1, 2]);
    }
  });

  it('still buffers a normal return through the transformer', async () => {
    const res = await runPipeline({ steps: [], handler: () => 'hi', transformer: () => ({ body: 'HI' }), seed: {}, bus, transport: 'buffer' });
    expect(isStreamResult(res)).toBe(false);
    if (!isStreamResult(res)) expect(res.body).toBe('HI');
  });
});

describe('runPipeline transport enforcement', () => {
  const bus = new Bus();
  const noTransform = (v: unknown) => ({ body: String(v) });
  async function* gen() { yield 1; }

  it('renders a 500 mismatch when a buffered route returns an AsyncIterable', async () => {
    const res = await runPipeline({ steps: [], handler: () => gen(), transformer: noTransform, seed: {}, bus, transport: 'buffer' });
    expect(isStreamResult(res)).toBe(false);
    if (!isStreamResult(res)) {
      expect(res.status).toBe(500);
      expect(res.body).toContain('must return a value');
    }
  });

  it('renders a 500 mismatch when a streaming route returns a non-iterable', async () => {
    const res = await runPipeline({ steps: [], handler: () => ({ x: 1 }), transformer: noTransform, seed: {}, bus, transport: 'sse' });
    expect(isStreamResult(res)).toBe(false);
    if (!isStreamResult(res)) {
      expect(res.status).toBe(500);
      expect(res.body).toContain('must return an AsyncIterable');
    }
  });

  it('negotiate tolerates a value (buffered)', async () => {
    const res = await runPipeline({ steps: [], handler: () => 'hi', transformer: noTransform, seed: {}, bus, transport: 'negotiate' });
    expect(isStreamResult(res)).toBe(false);
  });

  it('negotiate tolerates an AsyncIterable (stream)', async () => {
    const res = await runPipeline({ steps: [], handler: () => gen(), transformer: noTransform, seed: {}, bus, transport: 'negotiate' });
    expect(isStreamResult(res)).toBe(true);
  });
});

describe('runSteps accumulation', () => {
  // A chain where step k reads s{k-1} and provides s{k} = s{k-1} + 1: proves each
  // step observes the previous ones' output (the graph's whole point).
  const chain = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      const k = i + 1;
      return { name: `s${k}`, origin: 'mod', run: (ctx: any) => ({ [`s${k}`]: (ctx[`s${k - 1}`] ?? 0) + 1 }) };
    });

  it('each step sees prior outputs; the final context holds them all', async () => {
    const ctx = await runSteps(chain(50), {}, new Bus());
    expect(ctx.s1).toBe(1);
    expect(ctx.s50).toBe(50); // 50 only lands if every step saw the previous
    expect(Object.keys(ctx)).toHaveLength(50);
  });

  // Regression guard for the O(n^2) context merge (was `context = { ...context, ...output }`,
  // which handed every step a freshly copied object — quadratic in the step count). The fix
  // accumulates into ONE object in place, so every step must observe the same instance.
  it('accumulates into a single object in place — never a per-step copy', async () => {
    const seen: unknown[] = [];
    const steps = Array.from({ length: 6 }, (_, i) => ({
      name: `s${i}`,
      origin: 'mod',
      run: (ctx: any) => { seen.push(ctx); return { [`k${i}`]: i }; },
    }));
    const out = await runSteps(steps, { req: {} }, new Bus());
    for (const ctx of seen) expect(ctx).toBe(seen[0]); // a spread would hand each step a new object
    expect(out).toBe(seen[0]); // and the returned context is that same accumulator
    expect((out as any).k5).toBe(5);
  });
});
