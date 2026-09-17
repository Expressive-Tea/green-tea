import { expect, test, vi } from 'vitest';
import { Bus } from '../src/bus';
import { mountPlugin, Plugin, ScopeApi } from '../src/plugin';
import type { TeardownFn } from '../src/lifecycle';

const noTeardown = (): ((fn: TeardownFn) => void) => () => {};

test('plugin can observe via bus.on and add to its own scope', () => {
  const bus = new Bus();
  const added: string[] = [];
  const scope: ScopeApi = { add: (n) => added.push(n.name) };

  const logger: Plugin = {
    name: 'logger',
    mount(api) {
      api.bus.on('request:step:enter', () => {});
      api.scope.add({ kind: 'step', name: 'log', needs: [], provides: [], run: () => ({}) });
    },
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
  const plugin: Plugin = {
    name: 'emit-probe',
    mount(api) {
      expect((api.bus as any).emit).toBeUndefined();
    },
  };
  mountPlugin(plugin, bus, scope, noTeardown());
});

test('plugin can register a teardown, and it reaches the registry', () => {
  const bus = new Bus();
  const registered: TeardownFn[] = [];
  const plugin: Plugin = {
    name: 'teardown-registrar',
    mount(api) {
      api.onShutdown(() => {});
    },
  };

  mountPlugin(plugin, bus, { add: () => {} }, (fn) => registered.push(fn));

  expect(registered).toHaveLength(1);
});

// A plugin that opens nothing registers nothing: `onShutdown` is opt-in, and the teardown registry
// stays empty rather than collecting no-ops. (The shape guarantee this test used to assert went
// away with the move to `{ name, mount }` — see CHANGELOG, Breaking.)
test('a plugin that never calls onShutdown registers no teardown', () => {
  const bus = new Bus();
  const added: string[] = [];
  const registered: TeardownFn[] = [];
  const quiet: Plugin = {
    name: 'quiet',
    mount(api) {
      api.bus.on('stream:open', () => {});
      api.scope.add({ kind: 'provider', name: 'thing', needs: [], provides: ['thing'], run: () => ({}) });
    },
  };

  const mounted = vi.fn();
  bus.on('plugin:mounted', mounted);
  mountPlugin(quiet, bus, { add: (n) => added.push(n.name) }, (fn) => registered.push(fn));

  expect(added).toEqual(['thing']);
  expect(mounted).toHaveBeenCalledWith(expect.objectContaining({ name: 'quiet' }));
  expect(registered).toHaveLength(0);
});
