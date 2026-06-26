import { Bus } from './bus';

export interface ScopeNode {
  kind: 'step' | 'provider';
  name: string;
  needs: string[];
  provides: string[];
  run: (ctx: any) => any;
}

export interface ScopeApi { add(node: ScopeNode): void }
export interface PluginApi { bus: { on: Bus['on'] }; scope: ScopeApi }
export type Plugin = (api: PluginApi) => void;

export function mountPlugin(plugin: Plugin, bus: Bus, scope: ScopeApi): void {
  // Hand the plugin ONLY on() and add(). No emit, no other scope. Isolation is structural.
  const api: PluginApi = { bus: { on: bus.on.bind(bus) }, scope };
  plugin(api);
  bus.emit('plugin:mounted', { name: plugin.name || 'anonymous' });
}
