import 'reflect-metadata';

export type Ctor = new (...args: any[]) => any;
export type TransformerFn = (value: unknown) => { status?: number; headers?: Record<string, string>; body: string };

export interface ProviderMeta { provides: string; needs: string[]; optional: boolean; export: boolean }
export interface StepMeta { provides: string; needs: string[]; optional: boolean; export: boolean }
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Transport = 'buffer' | 'sse' | 'ndjson' | 'negotiate' | 'ws';
export interface RouteMeta { method: HttpMethod; path: string; handlerName: string; transport: Transport; export: boolean; duplicates?: 'array' | 'last' }
export interface ModuleOptions {
  mountpoint: string; providers?: Ctor[]; steps?: Ctor[]; controllers?: Ctor[];
}

const K = {
  provider: Symbol('gt:provider'),
  step: Symbol('gt:step'),
  routePrefix: Symbol('gt:routePrefix'),
  routes: Symbol('gt:routes'),
  module: Symbol('gt:module'),
  transformer: Symbol('gt:transformer'),
};

export function Provider(opts: { provides: string; needs?: string[]; optional?: boolean; export?: boolean }): ClassDecorator {
  return (target) => {
    const meta: ProviderMeta = { provides: opts.provides, needs: opts.needs ?? [], optional: opts.optional ?? false, export: opts.export ?? false };
    Reflect.defineMetadata(K.provider, meta, target);
  };
}

export function Step(opts: { provides: string; needs?: string[]; optional?: boolean; export?: boolean }): ClassDecorator {
  return (target) => {
    const meta: StepMeta = { provides: opts.provides, needs: opts.needs ?? [], optional: opts.optional ?? false, export: opts.export ?? false };
    Reflect.defineMetadata(K.step, meta, target);
  };
}

export function Route(prefix: string): ClassDecorator {
  return (target) => { Reflect.defineMetadata(K.routePrefix, prefix, target); };
}

function routeDecorator(method: HttpMethod, transport: Transport) {
  return (path: string, opts?: { export?: boolean; duplicates?: 'array' | 'last' }): MethodDecorator =>
    (target, propertyKey) => {
      const ctor = target.constructor;
      const routes = (Reflect.getMetadata(K.routes, ctor) as RouteMeta[]) ?? [];
      routes.push({ method, path, handlerName: String(propertyKey), transport, export: opts?.export ?? false, duplicates: opts?.duplicates });
      Reflect.defineMetadata(K.routes, routes, ctor);
    };
}

export const Get = routeDecorator('GET', 'buffer');
export const Post = routeDecorator('POST', 'buffer');
export const Put = routeDecorator('PUT', 'buffer');
export const Patch = routeDecorator('PATCH', 'buffer');
export const Delete = routeDecorator('DELETE', 'buffer');
export const Sse = routeDecorator('GET', 'sse');
export const Stream = routeDecorator('GET', 'negotiate');
export const Ws = routeDecorator('GET', 'ws');

export function Transformer(fn: TransformerFn): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(K.transformer, fn, target.constructor, String(propertyKey));
  };
}

export function Module(opts: ModuleOptions): ClassDecorator {
  return (target) => { Reflect.defineMetadata(K.module, opts, target); };
}

export function getProviderMeta(cls: Ctor): ProviderMeta | undefined {
  return Reflect.getMetadata(K.provider, cls);
}
export function getStepMeta(cls: Ctor): StepMeta | undefined {
  return Reflect.getMetadata(K.step, cls);
}
export function getModuleMeta(cls: Ctor): ModuleOptions | undefined {
  return Reflect.getMetadata(K.module, cls);
}
export function getTransformer(cls: Ctor, methodName: string): TransformerFn | undefined {
  return Reflect.getMetadata(K.transformer, cls, methodName);
}
export function getRoutes(cls: Ctor): RouteMeta[] {
  const prefix: string = Reflect.getMetadata(K.routePrefix, cls) ?? '';
  const routes: RouteMeta[] = Reflect.getMetadata(K.routes, cls) ?? [];
  return routes.map((r) => ({ ...r, path: joinPath(prefix, r.path) }));
}

export function joinPath(a: string, b: string): string {
  return `${a.replace(/\/$/, '')}/${b.replace(/^\//, '')}`.replace(/\/+/g, '/');
}
