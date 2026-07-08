import type { ArgSpec } from './params';

/** Minimal per-route input the OpenAPI projection needs, derived from a route plan. */
export interface OpenApiRoute {
  method: string;
  pattern: string;
  transport: string;
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

type Parameter = { name: string; in: 'path' | 'query' | 'header'; required: boolean; schema: { type: 'string' } };

/** Converts a route pattern to an OpenAPI path template: `/users/:id` → `/users/{id}`, `:rest*` → `{rest}`. */
function templatePath(pattern: string): string {
  const segments = pattern
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? `{${seg.slice(1).replace(/\*$/, '')}}` : seg));
  return `/${segments.join('/')}`;
}

/** Every `:name` (and `:name*`) segment of a pattern becomes a required path parameter. */
function pathParams(pattern: string): Parameter[] {
  return pattern
    .split('/')
    .filter((seg) => seg.startsWith(':'))
    .map((seg) => ({ name: seg.slice(1).replace(/\*$/, ''), in: 'path', required: true, schema: { type: 'string' } }));
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

/** The success/error responses documented for a route, keyed by transport and whether any input is validated. */
function responses(route: OpenApiRoute): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (route.transport === 'sse') {
    result['200'] = { description: 'Event stream', content: { 'text/event-stream': {} } };
  } else if (route.transport === 'ndjson' || route.transport === 'negotiate') {
    result['200'] = { description: 'Stream', content: { 'application/x-ndjson': {} } };
  } else {
    result['200'] = { description: 'OK', content: { 'application/json': { schema: {} } } };
  }

  if (route.args.some((arg) => arg.schema)) result['422'] = { description: 'Validation failed' };
  result['500'] = { description: 'Internal Server Error' };
  return result;
}

/** Builds a single OpenAPI operation object for a route. */
function operation(route: OpenApiRoute): Record<string, unknown> {
  const parameters = [...pathParams(route.pattern), ...argParams(route.args)];
  const op: Record<string, unknown> = { responses: responses(route) };

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
    if (route.transport === 'ws') continue; // not an HTTP request/response
    const path = templatePath(route.pattern);
    (paths[path] ??= {})[route.method.toLowerCase()] = operation(route);
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
