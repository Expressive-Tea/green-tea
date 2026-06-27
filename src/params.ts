import 'reflect-metadata';
import type { Ctor } from './metadata';

export type Query = Record<string, string>;
export type Headers = Record<string, string | string[] | undefined>;
export type Context = Record<string, unknown>;

type ArgSource = 'ctx' | 'needs' | 'params' | 'query' | 'body' | 'headers' | 'inbound' | 'abort';
export interface ArgSpec { index: number; source: ArgSource; key?: string; keys?: string[] }

const ARGS = Symbol('gt:args');

function record(target: object, methodKey: string | symbol | undefined, spec: ArgSpec): void {
  if (methodKey === undefined) return; // constructor params not supported
  const ctor = target.constructor as Ctor;
  const map: Record<string, ArgSpec[]> = Reflect.getMetadata(ARGS, ctor) ?? {};
  const list = map[String(methodKey)] ?? [];
  list.push(spec);
  map[String(methodKey)] = list;
  Reflect.defineMetadata(ARGS, map, ctor);
}

function envelope(source: ArgSource) {
  return (arg?: string | string[]): ParameterDecorator =>
    (target, methodKey, index) => {
      const spec: ArgSpec = Array.isArray(arg)
        ? { index, source, keys: arg }
        : typeof arg === 'string'
        ? { index, source, key: arg }
        : { index, source };
      record(target, methodKey, spec);
    };
}

export const param = envelope('params');
export const query = envelope('query');
export const body = envelope('body');
export const headers = envelope('headers');

export function needs(key: string): ParameterDecorator {
  return (target, methodKey, index) => record(target, methodKey, { index, source: 'needs', key });
}

export function ctx(): ParameterDecorator {
  return (target, methodKey, index) => record(target, methodKey, { index, source: 'ctx' });
}

export function inbound(): ParameterDecorator {
  return (target, methodKey, index) => record(target, methodKey, { index, source: 'inbound' });
}

export function abort(): ParameterDecorator {
  return (target, methodKey, index) => record(target, methodKey, { index, source: 'abort' });
}

export function getArgs(cls: Ctor, methodName: string): ArgSpec[] {
  const map: Record<string, ArgSpec[]> = Reflect.getMetadata(ARGS, cls) ?? {};
  return [...(map[methodName] ?? [])].sort((a, b) => a.index - b.index);
}

export function getHandlerNeeds(specs: ArgSpec[]): string[] {
  return specs.filter((s) => s.source === 'needs' && s.key).map((s) => s.key as string);
}

export function resolveArgs(specs: ArgSpec[], context: Context): unknown[] {
  if (specs.length === 0) return [];
  const max = Math.max(...specs.map((s) => s.index));
  const args: unknown[] = new Array(max + 1).fill(undefined);
  for (const s of specs) args[s.index] = resolveOne(s, context);
  return args;
}

function resolveOne(s: ArgSpec, context: Context): unknown {
  if (s.source === 'ctx') return context;
  if (s.source === 'needs') return context[s.key as string];
  if (s.source === 'inbound') return context.inbound;
  if (s.source === 'abort') return context.abort;
  const bag = context[s.source];
  if (typeof bag !== 'object' || bag === null) return bag; // can't pick from a non-object; return as-is
  const record = bag as Record<string, unknown>;
  if (s.keys) {
    const out: Record<string, unknown> = {};
    for (const k of s.keys) out[k] = record[k];
    return out;
  }
  if (s.key !== undefined) return record[s.key];
  return record;
}
