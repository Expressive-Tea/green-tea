import type { StandardIssue } from './standard-schema';

/**
 * Error carrying an HTTP status code and optional response body. Base of all signals.
 * A subclass needing response headers (e.g. `location`, `retry-after`) sets `headers`
 * rather than requiring a special case in the error renderer.
 */
export class HttpError extends Error {
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
        ? 'buffered routes (@Get/@Post/@Put/@Patch/@Delete) must return a value — to stream, declare @Sse, @Stream, or @Ws'
        : 'streaming routes (@Sse/@Ws) must return an AsyncIterable (e.g. an async generator or channel())';
    super(500, `Transport '${transport}'${where} must ${expected}, but the handler returned a ${got}. ${fix}.`);
  }
}

/** Type guard: true if `error` is an {@link HttpError}. */
export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
