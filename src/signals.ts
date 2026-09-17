import type { StandardIssue } from './standard-schema';

/**
 * Brands, so an error is recognised across two copies of core — an app that installed one from npm
 * and a plugin that brought another from JSR, or two npm versions npm could not dedupe.
 * `instanceof` cannot do that: each copy has its own class identity.
 *
 * `Symbol.for` is registry-wide, so both copies resolve the same symbol. The *string* is the public
 * protocol (`.specs/2026-09-15-plugin-ecosystem-design.md`, 1.2): a plugin that imports only types
 * cannot import this constant, so it writes `Symbol.for('green-tea.http-error')` itself.
 *
 * `unique symbol` is required by TypeScript for a computed class field, and `Symbol.for` on a `const`
 * satisfies it.
 */
export const HTTP_ERROR: unique symbol = Symbol.for('green-tea.http-error');
export const VALIDATION_ERROR: unique symbol = Symbol.for('green-tea.validation-error');

/** The shape core reads off a branded error. Anything carrying the brand should satisfy it. */
export interface HttpErrorLike {
  status: number;
  message: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Error carrying an HTTP status code and optional response body. Base of all signals.
 * A subclass needing response headers (e.g. `location`, `retry-after`) sets `headers`
 * rather than requiring a special case in the error renderer.
 */
export class HttpError extends Error {
  readonly [HTTP_ERROR] = true;

  constructor(
    readonly status: number,
    message?: string,
    readonly body?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? `HTTP ${status}`);
    this.name = new.target.name;
  }
}

/** 401 Unauthorized. */
export class Unauthorized extends HttpError {
  constructor(message?: string) {
    super(401, message);
  }
}

/** 404 Not Found. */
export class NotFound extends HttpError {
  constructor(message?: string) {
    super(404, message);
  }
}

/** 304 Not Modified. */
export class NotModified extends HttpError {
  constructor() {
    super(304);
  }
}

/** 302 redirect to `location`. */
export class Redirect extends HttpError {
  constructor(readonly location: string) {
    super(302, undefined, undefined, { location });
  }
}

/** 422 raised when request input fails Standard Schema validation. */
export class ValidationError extends HttpError {
  readonly [VALIDATION_ERROR] = true;

  constructor(
    public issues: StandardIssue[],
    public source: string,
  ) {
    super(422, 'Validation failed');
  }
}

/** Thrown when a handler's return value contradicts its route's declared transport (a programming error). */
export class TransportMismatchError extends HttpError {
  constructor(transport: string, got: 'stream' | 'value', req?: { method?: string; url?: string }) {
    const where = req?.method && req?.url ? ` (${req.method} ${req.url})` : '';
    const expected = got === 'stream' ? 'return a value' : 'return an AsyncIterable';
    const fix =
      got === 'stream'
        ? 'buffered routes (@Get/@Head/@Post/@Put/@Patch/@Delete/@Options) must return a value — to stream, declare @Sse, @Stream, or @Ws'
        : 'streaming routes (@Sse/@Ws) must return an AsyncIterable (e.g. an async generator or channel())';
    super(500, `Transport '${transport}'${where} must ${expected}, but the handler returned a ${got}. ${fix}.`);
  }
}

/** Type guard: true if `error` carries the HTTP-error brand — this copy's or another's. */
export function isHttpError(error: unknown): error is HttpErrorLike {
  return typeof error === 'object' && error !== null && HTTP_ERROR in error;
}

/** Type guard: true if `error` carries the validation brand. */
export function isValidationError(error: unknown): error is ValidationError {
  return typeof error === 'object' && error !== null && VALIDATION_ERROR in error;
}
