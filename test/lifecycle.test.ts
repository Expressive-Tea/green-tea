import { describe, it, expect, vi } from 'vitest';
import { TeardownRegistry, type TeardownFn } from '../src/lifecycle';
import type { Logger } from '../src/logger';

const silentLogger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('TeardownRegistry', () => {
  it('runs callbacks newest first, so a dependant tears down before its dependency', async () => {
    const order: string[] = [];
    const registry = new TeardownRegistry();
    // Providers register as they boot, and they boot in topological order — so `db` registering
    // before `cache` is what a `cache` needing `db` actually looks like here.
    registry.add(() => void order.push('db'));
    registry.add(() => void order.push('cache'));

    await registry.run(silentLogger());

    expect(order).toEqual(['cache', 'db']);
  });

  it('awaits each callback before starting the next', async () => {
    const order: string[] = [];
    const registry = new TeardownRegistry();
    registry.add(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('slow');
    });
    registry.add(() => void order.push('fast'));

    await registry.run(silentLogger());

    // 'fast' is registered last so it runs first; 'slow' must still have finished by return.
    expect(order).toEqual(['fast', 'slow']);
  });

  it('logs a throwing callback and still runs the rest', async () => {
    const logger = silentLogger();
    const order: string[] = [];
    const registry = new TeardownRegistry();
    registry.add(() => void order.push('first'));
    registry.add(() => {
      throw new Error('boom');
    });
    registry.add(() => void order.push('third'));

    await expect(registry.run(logger)).resolves.toBeUndefined();
    expect(order).toEqual(['third', 'first']);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatch(/boom/);
  });

  it('treats a rejecting async callback the same as a throwing one', async () => {
    const logger = silentLogger();
    const registry = new TeardownRegistry();
    registry.add(() => Promise.reject(new Error('async boom')));
    registry.add(() => Promise.resolve());

    await expect(registry.run(logger)).resolves.toBeUndefined();
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatch(/async boom/);
  });

  it('does not re-run callbacks on a second close()', async () => {
    let runs = 0;
    const registry = new TeardownRegistry();
    registry.add(() => void runs++);

    await registry.run(silentLogger());
    await registry.run(silentLogger());

    expect(runs).toBe(1);
  });

  it('resolves when nothing is registered, and reports an empty size', async () => {
    const registry = new TeardownRegistry();
    expect(registry.size).toBe(0);
    await expect(registry.run(silentLogger())).resolves.toBeUndefined();
  });

  it('reports how many callbacks are registered', () => {
    const registry = new TeardownRegistry();
    const noop: TeardownFn = () => {};
    registry.add(noop);
    registry.add(noop);
    expect(registry.size).toBe(2);
  });
});
