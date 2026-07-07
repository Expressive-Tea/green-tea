import 'reflect-metadata';

/** Any class constructor. Kept `any` because decorators must accept every target shape. */
export type Ctor = new (...args: any[]) => any;
/** Serializes a handler's return value into an HTTP response envelope. */
export type TransformerFn = (value: unknown) => { status?: number; headers?: Record<string, string>; body: string };

/** Metadata attached by `@Provider`: what it provides, what it needs, and its visibility. */
export interface ProviderMeta {
  provides: string;
  needs: string[];
  optional: boolean;
  export: boolean;
}
/** Metadata attached by `@Step`: what it provides, what it needs, and its visibility. */
export interface StepMeta {
  provides: string;
  needs: string[];
  optional: boolean;
  export: boolean;
}
/** HTTP verbs supported by the route decorators. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** Wire transport a route responds with. */
export type Transport = 'buffer' | 'sse' | 'ndjson' | 'negotiate' | 'ws';
/** Metadata attached by a route decorator to a single handler method. */
export interface RouteMeta {
  method: HttpMethod;
  path: string;
  handlerName: string;
  transport: Transport;
  export: boolean;
  duplicates?: 'array' | 'last';
}
/** Options accepted by the `@Module` decorator. */
export interface ModuleOptions {
  mountpoint: string;
  providers?: Ctor[];
  steps?: Ctor[];
  controllers?: Ctor[];
}

const K = {
  provider: Symbol('gt:provider'),
  step: Symbol('gt:step'),
  routePrefix: Symbol('gt:routePrefix'),
  routes: Symbol('gt:routes'),
  module: Symbol('gt:module'),
  transformer: Symbol('gt:transformer'),
};

/** Marks a class as a provider: a lazily-built dependency addressable by its `provides` key. */
export function Provider(opts: {
  provides: string;
  needs?: string[];
  optional?: boolean;
  export?: boolean;
}): ClassDecorator {
  return (target) => {
    const meta: ProviderMeta = {
      provides: opts.provides,
      needs: opts.needs ?? [],
      optional: opts.optional ?? false,
      export: opts.export ?? false,
    };
    Reflect.defineMetadata(K.provider, meta, target);
  };
}

/** Marks a class as a step: a per-request unit that runs in dependency order and contributes to the context. */
export function Step(opts: {
  provides: string;
  needs?: string[];
  optional?: boolean;
  export?: boolean;
}): ClassDecorator {
  return (target) => {
    const meta: StepMeta = {
      provides: opts.provides,
      needs: opts.needs ?? [],
      optional: opts.optional ?? false,
      export: opts.export ?? false,
    };
    Reflect.defineMetadata(K.step, meta, target);
  };
}

/** Sets the shared path prefix for every route declared on the decorated controller. */
export function Route(prefix: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(K.routePrefix, prefix, target);
  };
}

function routeDecorator(method: HttpMethod, transport: Transport) {
  return (path: string, opts?: { export?: boolean; duplicates?: 'array' | 'last' }): MethodDecorator =>
    (target, propertyKey) => {
      const ctor = target.constructor;
      const routes = (Reflect.getMetadata(K.routes, ctor) as RouteMeta[]) ?? [];
      routes.push({
        method,
        path,
        handlerName: String(propertyKey),
        transport,
        export: opts?.export ?? false,
        duplicates: opts?.duplicates,
      });
      Reflect.defineMetadata(K.routes, routes, ctor);
    };
}

/** Declares a buffered `GET` route. */
export const Get = routeDecorator('GET', 'buffer');
/** Declares a buffered `POST` route. */
export const Post = routeDecorator('POST', 'buffer');
/** Declares a buffered `PUT` route. */
export const Put = routeDecorator('PUT', 'buffer');
/** Declares a buffered `PATCH` route. */
export const Patch = routeDecorator('PATCH', 'buffer');
/** Declares a buffered `DELETE` route. */
export const Delete = routeDecorator('DELETE', 'buffer');
/** Declares a `GET` route streamed as Server-Sent Events. */
export const Sse = routeDecorator('GET', 'sse');
/** Declares a `GET` route whose transport is content-negotiated at request time. */
export const Stream = routeDecorator('GET', 'negotiate');
/** Declares a `GET` route upgraded to a WebSocket. */
export const Ws = routeDecorator('GET', 'ws');

/** Attaches a response transformer to a handler method. */
export function Transformer(fn: TransformerFn): MethodDecorator {
  return (target, propertyKey) => {
    Reflect.defineMetadata(K.transformer, fn, target.constructor, String(propertyKey));
  };
}

/** Marks a class as a module and records its providers, steps, controllers, and mountpoint. */
export function Module(opts: ModuleOptions): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(K.module, opts, target);
  };
}

/** Reads the `@Provider` metadata off a class, if any. */
export function getProviderMeta(cls: Ctor): ProviderMeta | undefined {
  return Reflect.getMetadata(K.provider, cls);
}

/** Reads the `@Step` metadata off a class, if any. */
export function getStepMeta(cls: Ctor): StepMeta | undefined {
  return Reflect.getMetadata(K.step, cls);
}

/** Reads the `@Module` metadata off a class, if any. */
export function getModuleMeta(cls: Ctor): ModuleOptions | undefined {
  return Reflect.getMetadata(K.module, cls);
}

/** Reads the response transformer registered for a handler method, if any. */
export function getTransformer(cls: Ctor, methodName: string): TransformerFn | undefined {
  return Reflect.getMetadata(K.transformer, cls, methodName);
}

/** Returns every route on a controller with its path resolved against the class prefix. */
export function getRoutes(cls: Ctor): RouteMeta[] {
  const prefix: string = Reflect.getMetadata(K.routePrefix, cls) ?? '';
  const routes: RouteMeta[] = Reflect.getMetadata(K.routes, cls) ?? [];
  return routes.map((route) => ({ ...route, path: joinPath(prefix, route.path) }));
}

/** Joins two path segments with exactly one slash, collapsing any duplicates. */
export function joinPath(base: string, segment: string): string {
  return `${base.replace(/\/$/, '')}/${segment.replace(/^\//, '')}`.replace(/\/+/g, '/');
}
