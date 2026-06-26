import { expect, test, vi } from 'vitest';
import { Bus } from '../src/bus';
import { mountPlugin, Plugin, ScopeApi } from '../src/plugin';

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
  mountPlugin(logger, bus, scope);

  expect(added).toEqual(['log']);
  expect(mounted).toHaveBeenCalled();
});

test('plugin api does NOT expose bus.emit', () => {
  const bus = new Bus();
  const scope: ScopeApi = { add: () => {} };
  const plugin: Plugin = (api) => {
    expect((api.bus as any).emit).toBeUndefined();
  };
  mountPlugin(plugin, bus, scope);
});
