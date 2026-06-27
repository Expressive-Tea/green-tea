import { describe, expect, it, test, vi } from 'vitest';
import { runPipeline, isStreamResult } from '../src/pipeline';
import { Bus } from '../src/bus';
import { JsonTransformer } from '../src/transformers';
import { Unauthorized } from '../src/signals';

const base = { transformer: JsonTransformer, seed: { req: { token: 'abc' } } };

test('runs steps, accumulates ctx, transforms handler return', async () => {
  const bus = new Bus();
  const res = await runPipeline({
    ...base, bus,
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
    ...base, bus,
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
    ...base, bus,
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
    const res = await runPipeline({ steps: [], handler: () => gen(), transformer: noTransform, seed: {}, bus });
    expect(isStreamResult(res)).toBe(true);
    if (isStreamResult(res)) {
      const out: unknown[] = [];
      for await (const v of res.stream) out.push(v);
      expect(out).toEqual([1, 2]);
    }
  });

  it('still buffers a normal return through the transformer', async () => {
    const res = await runPipeline({ steps: [], handler: () => 'hi', transformer: () => ({ body: 'HI' }), seed: {}, bus });
    expect(isStreamResult(res)).toBe(false);
    if (!isStreamResult(res)) expect(res.body).toBe('HI');
  });
});
