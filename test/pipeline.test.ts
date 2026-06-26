import { expect, test, vi } from 'vitest';
import { runPipeline } from '../src/pipeline';
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
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ user: 'abc' });
});

test('a thrown HttpError short-circuits to an error response', async () => {
  const bus = new Bus();
  const res = await runPipeline({
    ...base, bus,
    steps: [{ name: 'auth', origin: 'mod', run: () => { throw new Unauthorized('no'); } }],
    handler: () => ({ never: true }),
  });
  expect(res.status).toBe(401);
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
