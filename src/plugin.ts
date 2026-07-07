import { Bus } from './bus';

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
/** The capabilities handed to a plugin: event subscription and node registration only. */
export interface PluginApi {
  bus: { on: Bus['on'] };
  scope: ScopeApi;
}
/** A plugin: a function that wires itself up through the provided PluginApi. */
export type Plugin = (api: PluginApi) => void;

/** Runs a plugin against a restricted API, then emits `plugin:mounted`. */
export function mountPlugin(plugin: Plugin, bus: Bus, scope: ScopeApi): void {
  // Hand the plugin ONLY on() and add(). No emit, no other scope. Isolation is structural.
  const api: PluginApi = { bus: { on: bus.on.bind(bus) }, scope };
  plugin(api);
  bus.emit('plugin:mounted', { name: plugin.name || 'anonymous' });
}
