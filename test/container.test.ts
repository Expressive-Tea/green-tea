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

// GitHub #46: only the settled value was cached, so a second resolve that started before the first
// factory settled ran the factory again — two pools for one app-scoped token.
test('concurrent resolutions of an app-scoped token share one factory call', async () => {
  const c = new Container();
  const pending: (() => void)[] = [];
  const factory = vi.fn(() => new Promise((resolve) => pending.push(() => resolve({ pool: {} }))));
  c.register('db', 'app', factory);
  const both = Promise.all([c.resolve('db'), c.resolve('db')]);
  await Promise.resolve();
  for (const release of pending) release();
  const [a, b] = await both;
  expect(factory).toHaveBeenCalledTimes(1);
  expect(a).toBe(b);
});

// A rejection is not cached: the next resolve retries, as it did before #46. Callers that were
// already waiting on the failing attempt share its rejection rather than starting their own.
test('a rejected app-scoped factory is shared while in flight, then retried', async () => {
  const c = new Container();
  let calls = 0;
  const factory = vi.fn(async () => {
    calls += 1;
    if (calls === 1) throw new Error('refused');
    return { pool: calls };
  });
  c.register('db', 'app', factory);
  const results = await Promise.allSettled([c.resolve('db'), c.resolve('db')]);
  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  expect(factory).toHaveBeenCalledTimes(1);
  await expect(c.resolve('db')).resolves.toEqual({ pool: 2 });
  await expect(c.resolve('db')).resolves.toEqual({ pool: 2 });
  expect(factory).toHaveBeenCalledTimes(2);
});

test('a factory that throws synchronously rejects, and is retried', async () => {
  const c = new Container();
  let calls = 0;
  c.register('db', 'app', () => {
    calls += 1;
    if (calls === 1) throw new Error('sync');
    return 'ok';
  });
  await expect(c.resolve('db')).rejects.toThrow('sync');
  await expect(c.resolve('db')).resolves.toBe('ok');
});

test('resolve throws a clear error for an unknown token', async () => {
  const c = new Container();
  await expect(c.resolve('missing')).rejects.toThrow(/unknown token: missing/);
});
