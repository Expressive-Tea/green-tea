import { isHttpError, Redirect, ValidationError } from './signals';
import type { TransformerFn } from './metadata';
import { flattenPath } from './standard-schema';

export const JsonTransformer: TransformerFn = (value) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

export function errorToResponse(e: unknown): { status: number; headers: Record<string, string>; body: string } {
  if (e instanceof ValidationError) {
    return {
      status: 422,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: 'Validation failed',
        source: e.source,
        issues: e.issues.map((i) => ({ path: flattenPath(i), message: i.message })),
      }),
    };
  }
  if (isHttpError(e)) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (e instanceof Redirect) headers.location = e.location;
    return { status: e.status, headers, body: JSON.stringify({ error: e.message }) };
  }
  return {
    status: 500,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'Internal Server Error' }),
  };
}
