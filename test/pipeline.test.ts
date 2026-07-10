import { describe, expect, it, test, vi } from 'vitest';
import { runPipeline, isStreamResult } from '../src/pipeline';
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
