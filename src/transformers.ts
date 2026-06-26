import { isHttpError, Redirect } from './signals';
import type { TransformerFn } from './metadata';

export const JsonTransformer: TransformerFn = (value) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

export function errorToResponse(e: unknown): { status: number; headers: Record<string, string>; body: string } {
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
