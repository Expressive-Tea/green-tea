import { isHttpError, Redirect, ValidationError } from './signals';
import type { TransformerFn } from './metadata';
import { flattenPath } from './standard-schema';

/** A ready-to-send HTTP response. */
export interface ErrorResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The request a {@link ErrorRenderer} is given, to inspect (e.g. `headers.accept`) while rendering. */
export interface ErrorRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * User hook to render errors however you like (HTML, custom JSON, RFC 7807, …).
 * Return a response to take over, or `undefined`/`void` to fall back to the default JSON.
 */
export type ErrorRenderer = (error: unknown, req: ErrorRequest) => ErrorResponse | undefined | void;

/** Default transformer: serialize a handler's return value as a JSON `200` response. */
export const JsonTransformer: TransformerFn = (value) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

/**
 * Map a thrown value to a JSON error response (422 for validation, `HttpError` status, else 500).
 * An `HttpError` carrying a `body` renders that payload instead of the default `{ error: message }`.
 */
export function errorToResponse(error: unknown): ErrorResponse {
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
    const payload = error.body !== undefined ? error.body : { error: error.message };
    return { status: error.status, headers, body: JSON.stringify(payload) };
  }

  return {
    status: 500,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'Internal Server Error' }),
  };
}

/** Render an error through the optional user {@link ErrorRenderer}, falling back to {@link errorToResponse}. */
export function renderError(error: unknown, req: ErrorRequest, onError?: ErrorRenderer): ErrorResponse {
  return onError?.(error, req) ?? errorToResponse(error);
}
