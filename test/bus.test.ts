import { expect, test, vi } from 'vitest';
import { Bus } from '../src/bus';

test('subscribers receive emitted events', () => {
  const bus = new Bus();
  const spy = vi.fn();
  bus.on('request:step:enter', spy);
  bus.emit('request:step:enter', { name: 'auth' });
  expect(spy).toHaveBeenCalledWith({ name: 'auth' });
});

test('unsubscribe stops delivery', () => {
  const bus = new Bus();
  const spy = vi.fn();
  const off = bus.on('plugin:mounted', spy);
  off();
  bus.emit('plugin:mounted', { name: 'logger' });
  expect(spy).not.toHaveBeenCalled();
});

test('a throwing subscriber does not break emit for others', () => {
  const bus = new Bus();
  const good = vi.fn();
  bus.on('request:step:error', () => { throw new Error('boom'); });
  bus.on('request:step:error', good);
  expect(() => bus.emit('request:step:error', { name: 's' })).not.toThrow();
  expect(good).toHaveBeenCalled();
});

test('an async subscriber that rejects is isolated too (#70)', async () => {
  const bus = new Bus();
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const good = vi.fn();
    bus.on('request:end', async () => {
      throw new Error('boom');
    });
    bus.on('request:end', good);
    expect(() => bus.emit('request:end', { name: 'r' })).not.toThrow();
    expect(good).toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});
