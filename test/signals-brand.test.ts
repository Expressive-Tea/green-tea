// test/signals-brand.test.ts
import { describe, expect, it } from 'vitest';

import { errorToResponse } from '../src/transformers';
import { HttpError, ValidationError, isHttpError, isValidationError } from '../src/signals';

// What a plugin published from another package throws: it never imported core, so it is not an
// `instanceof` anything of ours. The brand is the whole contract — see .specs/2026-09-15, 1.2.
const HTTP_ERROR = Symbol.for('green-tea.http-error');

class ForeignTooManyRequests extends Error {
  readonly [HTTP_ERROR] = true;
  readonly status = 429;
  constructor(
    message: string,
    readonly headers: Record<string, string>,
  ) {
    super(message);
  }
}

describe('the error brand', () => {
  it('renders a foreign branded error with its own status and headers', () => {
    const response = errorToResponse(new ForeignTooManyRequests('slow down', { 'retry-after': '30' }));

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(JSON.parse(response.body)).toEqual({ error: 'slow down' });
  });

  it('recognises a foreign branded error through the guard', () => {
    expect(isHttpError(new ForeignTooManyRequests('slow down', {}))).toBe(true);
  });

  it("still recognises core's own errors", () => {
    expect(isHttpError(new HttpError(418, 'teapot'))).toBe(true);
    expect(isValidationError(new ValidationError([], 'body'))).toBe(true);
    expect(isValidationError(new HttpError(418, 'teapot'))).toBe(false);
  });

  it('does not claim an unbranded error', () => {
    expect(isHttpError(new Error('plain'))).toBe(false);
    expect(isHttpError(null)).toBe(false);
    expect(isHttpError({ status: 429 })).toBe(false);
  });

  it('renders a foreign validation error as 422 with its issues', () => {
    const foreign = Object.assign(new Error('Validation failed'), {
      [Symbol.for('green-tea.http-error')]: true,
      [Symbol.for('green-tea.validation-error')]: true,
      status: 422,
      source: 'body',
      issues: [{ path: ['email'], message: 'required' }],
    });

    const response = errorToResponse(foreign);

    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Validation failed',
      source: 'body',
      issues: [{ path: 'email', message: 'required' }],
    });
  });
});
