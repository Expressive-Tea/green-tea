import { expect, test, vi } from 'vitest';
import { Bus } from '../src/bus';
import { mountPlugin, Plugin, ScopeApi } from '../src/plugin';
import type { TeardownFn } from '../src/lifecycle';

const noTeardown = (): ((fn: TeardownFn) => void) => () => {};

test('plugin can observe via bus.on and add to its own scope', () => {
  const bus = new Bus();
  const added: string[] = [];
  const scope: ScopeApi = { add: (n) => added.push(n.name) };

  const logger: Plugin = (api) => {
    api.bus.on('request:step:enter', () => {});
    api.scope.add({ kind: 'step', name: 'log', needs: [], provides: [], run: () => ({}) });
  };

  const mounted = vi.fn();
  bus.on('plugin:mounted', mounted);
  mountPlugin(logger, bus, scope, noTeardown());

  expect(added).toEqual(['log']);
  expect(mounted).toHaveBeenCalled();
});

test('plugin api does NOT expose bus.emit', () => {
  const bus = new Bus();
  const scope: ScopeApi = { add: () => {} };
  const plugin: Plugin = (api) => {
    expect((api.bus as any).emit).toBeUndefined();
  };
  mountPlugin(plugin, bus, scope, noTeardown());
});

test('plugin can register a teardown, and it reaches the registry', () => {
  const bus = new Bus();
  const registered: TeardownFn[] = [];
  const plugin: Plugin = (api) => {
    api.onShutdown(() => {});
  };

  mountPlugin(plugin, bus, { add: () => {} }, (fn) => registered.push(fn));

  expect(registered).toHaveLength(1);
});

// D3's no-break guarantee, asserted rather than assumed: `Plugin`'s signature did not change, so a
// plugin written before this capability existed must mount and behave exactly as it did.
test('a plugin that never calls onShutdown behaves exactly as before', () => {
  const bus = new Bus();
  const added: string[] = [];
  const registered: TeardownFn[] = [];
  const legacy: Plugin = (api) => {
    api.bus.on('stream:open', () => {});
    api.scope.add({ kind: 'provider', name: 'thing', needs: [], provides: ['thing'], run: () => ({}) });
  };

  const mounted = vi.fn();
  bus.on('plugin:mounted', mounted);
  mountPlugin(legacy, bus, { add: (n) => added.push(n.name) }, (fn) => registered.push(fn));

  expect(added).toEqual(['thing']);
  expect(mounted).toHaveBeenCalled();
  expect(registered).toHaveLength(0);
});
