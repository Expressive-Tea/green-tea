import { Bus } from './bus';
import type { TeardownFn } from './lifecycle';

/** A step or provider a plugin contributes to the graph. */
export interface ScopeNode {
  kind: 'step' | 'provider';
  name: string;
  needs: string[];
  provides: string[];
  run: (ctx: any) => any;
}

/** The narrow surface a plugin uses to register nodes into the host graph. */
export interface ScopeApi {
  add(node: ScopeNode): void;
}
/** The capabilities handed to a plugin: event subscription, node registration, and teardown. */
export interface PluginApi {
  bus: { on: Bus['on'] };
  scope: ScopeApi;
  /**
   * Run something before the app closes — closing a pool, stopping a timer, flushing a buffer.
   *
   * Takes no arguments: whatever needs closing is already in the closure of the plugin that opened
   * it. It is awaited, unlike a `bus.on` listener, and a failure is logged rather than swallowed.
   */
  onShutdown(fn: TeardownFn): void;
}
/** A plugin: a function that wires itself up through the provided PluginApi. */
export type Plugin = (api: PluginApi) => void;

/** Runs a plugin against a restricted API, then emits `plugin:mounted`. */
export function mountPlugin(plugin: Plugin, bus: Bus, scope: ScopeApi, onShutdown: (fn: TeardownFn) => void): void {
  // Hand the plugin ONLY on(), add() and onShutdown(). No emit, no other scope, no container.
  //
  // "Isolation is structural" means this list and nothing else — it is a guarantee about the
  // *registration surface*, not about the request context. A plugin's step receives the live
  // context like any other step and can overwrite keys in it (`src/pipeline.ts`, `Object.assign`),
  // which is a separate, pre-existing question this list has never covered.
  //
  // `onShutdown` is the first capability here the framework must *wait* for: nothing a plugin did
  // before could delay the process. It cannot delay it without bound — `close()`'s deadline still
  // caps the whole shutdown.
  const api: PluginApi = { bus: { on: bus.on.bind(bus) }, scope, onShutdown };
  plugin(api);
  bus.emit('plugin:mounted', { name: plugin.name || 'anonymous' });
}
