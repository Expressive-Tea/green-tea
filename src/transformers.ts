import { isHttpError, Redirect, ValidationError } from './signals';
import type { TransformerFn } from './metadata';
import { flattenPath } from './standard-schema';

/** Default transformer: serialize a handler's return value as a JSON `200` response. */
export const JsonTransformer: TransformerFn = (value) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

/** Map a thrown value to a JSON error response (422 for validation, HttpError status, else 500). */
export function errorToResponse(error: unknown): { status: number; headers: Record<string, string>; body: string } {
  if (error instanceof ValidationError) {
    return {
      status: 422,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: 'Validation failed',
        source: error.source,
        issues: error.issues.map((issue) => ({ path: flattenPath(issue), message: issue.message })),
      }),
    };
  }

  if (isHttpError(error)) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (error instanceof Redirect) headers.location = error.location;
    return { status: error.status, headers, body: JSON.stringify({ error: error.message }) };
  }

  return {
    status: 500,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'Internal Server Error' }),
  };
}
