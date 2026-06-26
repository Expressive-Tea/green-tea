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
