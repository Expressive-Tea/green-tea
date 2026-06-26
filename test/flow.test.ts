import { expect, test } from 'vitest';
import { flow } from '../src/flow';

test('flow accumulates context and runs steps in order', async () => {
  const compiled = flow<{ req: { token: string } }>()
    .step('auth', (ctx) => ({ user: { id: ctx.req.token } }))
    .step('load', (ctx) => ({ greeting: `hi ${ctx.user.id}` }))
    .handle((ctx) => ctx.greeting);

  const result = await compiled.run({ req: { token: 'abc' } });
  expect(result).toBe('hi abc');
});

test('async steps are awaited and accumulate', async () => {
  const compiled = flow<{ n: number }>()
    .step('double', async (ctx) => ({ doubled: ctx.n * 2 }))
    .handle((ctx) => ctx.doubled);
  expect(await compiled.run({ n: 21 })).toBe(42);
});
