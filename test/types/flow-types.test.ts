import { test, expect } from 'vitest';
import { flow } from '../../src/flow';

test('type guarantee holds (this file must typecheck)', () => {
  // OK: handler reads `user`, produced by the auth step.
  flow<{ req: { token: string } }>()
    .step('auth', (ctx) => ({ user: ctx.req.token }))
    .handle((ctx) => ctx.user);

  // GUARANTEE: remove the auth step and reading `user` must NOT compile.
  flow<{ req: { token: string } }>()
    // @ts-expect-error — `user` is not in the accumulated context
    .handle((ctx) => ctx.user);

  expect(true).toBe(true);
});
