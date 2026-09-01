// Every extension point the docs tell a user to write must be *typeable* from the package, not just
// callable. A decorator whose argument type is not exported can be passed a literal and nothing
// else — the shape has to be redeclared inline, or borrowed off a value with
// `typeof JsonTransformer`, which works and reads like a trick because it is one.
//
// This file's job is to fail to compile if one of them stops being exported.
import { test, expect } from 'vitest';
import {
  JsonTransformer,
  type TransformerFn,
  type Plugin,
  type PluginApi,
  type ScopeApi,
  type ScopeNode,
  type Hooks,
  type TeardownFn,
  type ErrorRenderer,
  type StreamEncoder,
} from '../../src';

// @Transformer(fn) — the case that started this. Prometheus scrapes text, so a /metrics route
// needs its own transformer, and this is the annotation that was impossible to write.
const prometheusText: TransformerFn = (value) => ({
  status: 200,
  headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
  body: String(value),
});

// A plugin split into named functions rather than one inline arrow: `Plugin` alone types the
// arrow, and nothing typed its argument.
function subscribe(api: PluginApi): void {
  api.bus.on('request:end', () => {});
  api.onShutdown(flush);
}

const flush: TeardownFn = () => {};

function contribute(scope: ScopeApi): void {
  const node: ScopeNode = { kind: 'provider', name: 'metrics', needs: [], provides: ['metrics'], run: () => ({}) };
  scope.add(node);
}

const metricsPlugin: Plugin = (api) => {
  subscribe(api);
  contribute(api.scope);
};

// createApp({ hooks }) — declared as a value, which is the point of the option.
const hooks: Hooks[] = [{ onShutdown: flush }];

// The two neighbouring extension points, already exported. Here so a future barrel edit that drops
// one is caught by the same test rather than by a user.
const renderError: ErrorRenderer = () => ({ status: 500, headers: {}, body: 'boom' });
const encoder: StreamEncoder = {
  headers: {},
  encode: (item) => String(item),
  encodeError: (err) => String(err),
};

test('every extension point is typeable from the package barrel', () => {
  expect(prometheusText('x').body).toBe('x');
  expect(typeof metricsPlugin).toBe('function');
  expect(hooks).toHaveLength(1);
  expect(renderError(new Error('boom'), {} as never)?.status).toBe(500);
  expect(encoder.encode(1)).toBe('1');
  // The workaround the missing export forced, kept as a reminder of what it replaced.
  expect(typeof JsonTransformer).toBe('function');
});
