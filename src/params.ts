import 'reflect-metadata';
import type { Ctor } from './metadata';
import { isStandardSchema, type StandardSchemaV1 } from './standard-schema';
import { ValidationError } from './signals';
import { parseCookies } from './cookies';

/** Parsed URL query string as flat key/value pairs. */
export type Query = Record<string, string>;
/** Incoming request headers; a header may repeat, hence the array variant. */
export type RequestHeaders = Record<string, string | string[] | undefined>;
/**
 * @deprecated Use {@link RequestHeaders}. This name shadows the Fetch `Headers` global in any file
 * that imports it; it stays as an alias so existing imports keep compiling.
 */
export type Headers = RequestHeaders;
/** Per-request bag that accumulates values produced by steps and providers. */
export type Context = Record<string, unknown>;

type ArgSource = 'ctx' | 'needs' | 'params' | 'query' | 'body' | 'headers' | 'cookies' | 'inbound' | 'abort';
/** Describes how a single handler parameter is sourced and (optionally) validated. */
export interface ArgSpec {
  index: number;
  source: ArgSource;
  key?: string;
  keys?: string[];
  schema?: StandardSchemaV1;
}

const ARGS = Symbol('gt:args');

function record(target: object, methodKey: string | symbol | undefined, spec: ArgSpec): void {
  if (methodKey === undefined) return; // constructor params not supported
  const ctor = target.constructor as Ctor;
  // Copy, never mutate (GitHub #44): `getMetadata` walks the prototype chain, so on a subclass the
  // map and list it returns are the base class's, and pushing into them decorated the base too.
  const map: Record<string, ArgSpec[]> = { ...(Reflect.getMetadata(ARGS, ctor) ?? {}) };
  map[String(methodKey)] = [...(map[String(methodKey)] ?? []), spec];
  Reflect.defineMetadata(ARGS, map, ctor);
}

/**
 * The shape every argument decorator shares: an optional key, key list or schema, an optional
 * second schema, and the `ParameterDecorator` that records the resulting spec.
 *
 * Named for the same reason as `RouteDecorator` in `./metadata` — JSR rejects an inferred type on a
 * public symbol, because consumers would have to re-derive it from the implementation on every check.
 */
export type ArgDecorator = (
  arg?: string | string[] | StandardSchemaV1,
  schema?: StandardSchemaV1,
) => ParameterDecorator;

function envelope(source: ArgSource): ArgDecorator {
  return (arg, schema) => (target, methodKey, index) => {
    const spec: ArgSpec = { index, source };
    if (Array.isArray(arg)) spec.keys = arg;
    else if (typeof arg === 'string') spec.key = arg;
    else if (isStandardSchema(arg)) spec.schema = arg;
    else if (arg !== undefined) throw new Error(`@${source}: expected a Standard Schema or a string/array key`);

    if (schema !== undefined) {
      if (!isStandardSchema(schema)) throw new Error(`@${source}: second argument must be a Standard Schema`);
      spec.schema = schema;
    }

    record(target, methodKey, spec);
  };
}

/** Inject a route path parameter; pass a key to pick one, or a schema/array to shape it. */
export const param: ArgDecorator = envelope('params');
/** Inject a query-string value; pass a key to pick one, or a schema/array to shape it. */
export const query: ArgDecorator = envelope('query');
/** Inject the request body; pass a schema to validate it. */
export const body: ArgDecorator = envelope('body');
/** Inject request headers; pass a key to pick one, an array to pick several, or no arg for the whole bag. */
export const headers: ArgDecorator = envelope('headers');
/** Inject a single request header by name (singular alias of {@link headers}); accepts a schema to validate it. */
export const header: ArgDecorator = envelope('headers');
/**
 * Inject request cookies, parsed from the `Cookie` header: no arg for the whole map (`{}` when the
 * request has none), a key to pick one, an array to pick several. Accepts a schema to validate.
 * First value wins for a repeated name, `%`-sequences are decoded, malformed pairs are skipped.
 */
export const cookies: ArgDecorator = envelope('cookies');
/** Inject a single request cookie by name (singular alias of {@link cookies}); `undefined` when absent. */
export const cookie: ArgDecorator = envelope('cookies');

/** Inject a value produced upstream by a step or provider, addressed by key. */
export function needs(key: string): ParameterDecorator {
  return (target, methodKey, index) => record(target, methodKey, { index, source: 'needs', key });
}

/** Inject the whole request context bag. */
export function ctx(): ParameterDecorator {
  return (target, methodKey, index) => record(target, methodKey, { index, source: 'ctx' });
}

/** Inject the inbound stream (for streaming/upload handlers). */
export function inbound(): ParameterDecorator {
  return (target, methodKey, index) => record(target, methodKey, { index, source: 'inbound' });
}

/** Inject the request's abort signal. */
export function abort(): ParameterDecorator {
  return (target, methodKey, index) => record(target, methodKey, { index, source: 'abort' });
}

/** Read the recorded parameter specs for a handler method, ordered by parameter index. */
export function getArgs(cls: Ctor, methodName: string): ArgSpec[] {
  const map: Record<string, ArgSpec[]> = Reflect.getMetadata(ARGS, cls) ?? {};
  return [...(map[methodName] ?? [])].sort((a, b) => a.index - b.index);
}

/** Extract the `@needs` keys a handler depends on, for dependency resolution. */
export function getHandlerNeeds(specs: ArgSpec[]): string[] {
  return specs.filter((spec) => spec.source === 'needs' && spec.key).map((spec) => spec.key as string);
}

/** Build the positional argument array for a handler by sourcing and validating each spec. */
export async function resolveArgs(specs: ArgSpec[], context: Context): Promise<unknown[]> {
  if (specs.length === 0) return [];
  const maxIndex = Math.max(...specs.map((spec) => spec.index));
  const args: unknown[] = new Array(maxIndex + 1).fill(undefined);

  for (const spec of specs) {
    let value = resolveOne(spec, context);

    if (spec.schema) {
      const result = await spec.schema['~standard'].validate(value);
      if (result.issues) throw new ValidationError([...result.issues], spec.source);
      value = result.value;
    }

    args[spec.index] = value;
  }

  return args;
}

function resolveOne(spec: ArgSpec, context: Context): unknown {
  if (spec.source === 'ctx') return context;
  // `cookies` is a seed token like `headers`, but parsed on demand rather than seeded on every request.
  if (spec.source === 'needs') return spec.key === 'cookies' ? cookiesOf(context) : context[spec.key as string];
  if (spec.source === 'inbound') return context.inbound;
  if (spec.source === 'abort') return context.abort;
  const bag = spec.source === 'cookies' ? cookiesOf(context) : context[spec.source];
  if (typeof bag !== 'object' || bag === null) return bag; // can't pick from a non-object; return as-is
  const values = bag as Record<string, unknown>;
  // Every adapter stores header names lower-cased, so `@header('Content-Type')` looks up
  // `content-type` (GitHub #37). A picked bag keeps the names as the handler wrote them.
  const at = spec.source === 'headers' ? (key: string) => values[key.toLowerCase()] : (key: string) => values[key];

  if (spec.keys) {
    const picked: Record<string, unknown> = {};
    for (const key of spec.keys) picked[key] = at(key);
    return picked;
  }

  if (spec.key !== undefined) return at(spec.key);
  return values;
}

/**
 * The request's cookie map, parsed on first use and cached on the context, so a route that never
 * declares a cookie argument never parses the header and one that declares several parses it once.
 * Serves `@cookie`, `@cookies` and `@needs('cookies')` alike.
 */
function cookiesOf(context: Context): unknown {
  if (context.cookies === undefined) {
    const headers = context.headers as RequestHeaders | undefined;
    context.cookies = parseCookies(headers?.cookie);
  }

  return context.cookies;
}
