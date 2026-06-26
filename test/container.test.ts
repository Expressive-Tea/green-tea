import { expect, test, vi } from 'vitest';
import { Container } from '../src/container';

test('app-scoped factory is memoized (runs once)', async () => {
  const c = new Container();
  const factory = vi.fn(async () => ({ db: 'connected' }));
  c.register('db', 'app', factory);
  const a = await c.resolve('db');
  const b = await c.resolve('db');
  expect(a).toBe(b);
  expect(factory).toHaveBeenCalledTimes(1);
});

test('resolve is async even for sync factories', async () => {
  const c = new Container();
  c.register('cfg', 'app', () => ({ port: 3000 }));
  await expect(c.resolve('cfg')).resolves.toEqual({ port: 3000 });
});

test('resolve throws a clear error for an unknown token', async () => {
  const c = new Container();
  await expect(c.resolve('missing')).rejects.toThrow(/unknown token: missing/);
});
