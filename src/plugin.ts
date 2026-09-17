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
/**
 * The capabilities handed to a plugin: event subscription, node registration, and teardown.
 *
 * This is the home for observation, and the reason is the pairing: `bus.on` arrives next to
 * `onShutdown`, so whatever a plugin subscribes to it can also release. A graph node can reach the
 * same read-only slice through `@needs('events')`, but it gets the subscribe half without the
 * unsubscribe half — and a `@Step` reaching it would register a listener per request.
 *
 * The `Bus` itself is deliberately not here and is not a graph token either: handing over `emit`
 * would turn a one-way observation channel into something any node can forge events on.
 * `@needs('bus')` fails at boot and says so.
 */
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
/**
 * A plugin: a named object that wires itself up through the provided PluginApi.
 *
 * The name is a field rather than `fn.name` because `fn.name` cannot be relied on: an arrow
 * returned straight from a factory has `""`, `const plugin = …` reports `"plugin"`, and a minifier
 * rewrites both. The name is what `plugin:mounted` reports and what a failed mount is blamed on, so
 * it has to be the author's word, not the bundler's.
 */
export interface Plugin {
  readonly name: string;
  mount(api: PluginApi): void;
}

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

  try {
    plugin.mount(api);
  } catch (error) {
    // Without the name this surfaces as somebody else's stack trace: mounting happens inside
    // createApp, so the application sees a throw from a line it never wrote.
    throw new Error(`plugin "${plugin.name}" failed to mount: ${(error as Error).message}`, { cause: error });
  }

  bus.emit('plugin:mounted', { name: plugin.name });
}
