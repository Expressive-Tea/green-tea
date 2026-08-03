import type { ArgSpec } from './params';
import type { Transport } from './metadata';
import { compilePattern } from './http/router';

/** Minimal per-route input the OpenAPI projection needs, derived from a route plan. */
export interface OpenApiRoute {
  method: string;
  pattern: string;
  transport: Transport;
  args: ArgSpec[];
}

/** `info` block overrides for the generated document. */
export interface OpenApiInfo {
  title?: string;
  version?: string;
  description?: string;
}

/** A generated OpenAPI 3.1 document (structural: paths, params, and error responses; body/response schemas are generic). */
export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, unknown>>;
}

type Parameter = {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: { type: 'string'; pattern?: string };
};

/** Converts a route pattern to an OpenAPI path template: `/users/:id` → `/users/{id}`, `:rest*` → `{rest}`. */
function templatePath(pattern: string): string {
  const segments = compilePattern(pattern).segments.map((segment) =>
    segment.kind === 'static' ? segment.value : `{${segment.name}}`,
  );
  return `/${segments.join('/')}`;
}

/** Every `:name` (and `:name*`) segment of a pattern becomes a required path parameter. */
function pathParams(pattern: string): Parameter[] {
  return compilePattern(pattern).segments.flatMap((segment): Parameter[] => {
    if (segment.kind === 'static') return [];
    return [
      {
        name: segment.name,
        in: 'path',
        required: true,
        schema: {
          type: 'string',
          ...(segment.kind === 'param' && segment.constraintSource ? { pattern: segment.constraintSource } : {}),
        },
      },
    ];
  });
}

/** Query and header parameters declared by the handler's `@query` / `@headers` / `@header` argument decorators. */
function argParams(args: ArgSpec[]): Parameter[] {
  const params: Parameter[] = [];

  for (const arg of args) {
    if (arg.source !== 'query' && arg.source !== 'headers') continue;
    const location = arg.source === 'query' ? 'query' : 'header';
    const names = arg.keys ?? (arg.key ? [arg.key] : []);
    for (const name of names) params.push({ name, in: location, required: false, schema: { type: 'string' } });
  }

  return params;
}

/**
 * The documented `200` per transport. `ws` is absent by construction — ws routes are not
 * HTTP request/response and are filtered out before this runs. A new transport adds a row,
 * and the compiler fails until it does.
 */
type HttpTransport = Exclude<Transport, 'ws'>;

const TRANSPORT_OK: Record<HttpTransport, Record<string, unknown>> = {
  buffer: { description: 'OK', content: { 'application/json': { schema: {} } } },
  sse: { description: 'Event stream', content: { 'text/event-stream': {} } },
  ndjson: { description: 'Stream', content: { 'application/x-ndjson': {} } },
  negotiate: { description: 'Stream', content: { 'application/x-ndjson': {} } },
};

/** The success/error responses documented for a route, keyed by transport and whether any input is validated. */
function responses(route: OpenApiRoute, transport: HttpTransport): Record<string, unknown> {
  const result: Record<string, unknown> = { '200': TRANSPORT_OK[transport] };

  if (route.args.some((arg) => arg.schema)) result['422'] = { description: 'Validation failed' };
  result['500'] = { description: 'Internal Server Error' };
  return result;
}

/** Builds a single OpenAPI operation object for a route. */
function operation(route: OpenApiRoute, transport: HttpTransport): Record<string, unknown> {
  const parameters = [...pathParams(route.pattern), ...argParams(route.args)];
  const op: Record<string, unknown> = { responses: responses(route, transport) };

  if (parameters.length) op.parameters = parameters;

  if (route.args.some((arg) => arg.source === 'body')) {
    op.requestBody = { content: { 'application/json': { schema: {} } } };
  }

  return op;
}

/**
 * Projects the route graph into a structural OpenAPI 3.1 document: paths, methods, path/query/header
 * parameters, which routes take a body, and the systematic error responses. Body and response *schemas*
 * are generic — Standard Schema doesn't expose JSON Schema (see the roadmap). WebSocket routes are omitted.
 */
export function buildOpenApi(routes: OpenApiRoute[], info?: OpenApiInfo): OpenApiDoc {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const transport = route.transport;
    if (transport === 'ws') continue; // not an HTTP request/response; narrows to HttpTransport below
    const path = templatePath(route.pattern);
    (paths[path] ??= {})[route.method.toLowerCase()] = operation(route, transport);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: info?.title ?? 'green-tea API',
      version: info?.version ?? '0.0.0',
      ...(info?.description ? { description: info.description } : {}),
    },
    paths,
  };
}
