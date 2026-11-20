import { expect, test, vi } from 'vitest';
import { Bus, reportListenerErrors } from '../src/bus';

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

test('a failing listener is reported once, sync or async, and others still run (#77)', async () => {
  const bus = new Bus();
  const reports: string[] = [];
  reportListenerErrors(bus, (event, error) => reports.push(`${event}:${(error as Error).message}`));
  const good = vi.fn();
  bus.on('request:end', () => {
    throw new Error('sync');
  });
  bus.on('request:end', async () => {
    throw new Error('async');
  });
  bus.on('request:end', good);

  for (let i = 0; i < 3; i++) bus.emit('request:end', { name: 'r' });
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(good).toHaveBeenCalledTimes(3);
  expect(reports.sort()).toEqual(['request:end:async', 'request:end:sync']);
});

test('a reporter that throws does not escape emit', () => {
  const bus = new Bus();
  reportListenerErrors(bus, () => {
    throw new Error('logger down');
  });
  bus.on('request:end', () => {
    throw new Error('boom');
  });
  expect(() => bus.emit('request:end', { name: 'r' })).not.toThrow();
});

test('createApp logs a broken plugin listener once, through its logger (#77)', async () => {
  const { createApp, Route, Get, Module } = await import('../src/index');
  @Route('/') class Ctl { @Get('/x') x() { return { ok: true }; } }
  @Module({ mountpoint: '/', controllers: [Ctl] }) class M {}
  const warned: string[] = [];
  const logger = { debug() {}, info() {}, error() {}, warn: (m: string) => warned.push(m) };
  const broken = { name: 'broken-metrics', mount: (api: any) => api.bus.on('request:end', () => { throw new Error('nope'); }) };
  const app = createApp({ modules: [M], plugins: [broken], logger });

  for (let i = 0; i < 3; i++) expect((await app.fetch(new Request('http://x/x'))).status).toBe(200);

  expect(warned.filter((m) => m.includes("listener on 'request:end' threw"))).toHaveLength(1);
});
