import type { StandardIssue } from './standard-schema';

/** Error carrying an HTTP status code and optional response body. Base of all signals. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message?: string,
    readonly body?: unknown,
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
    super(302);
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

/** Type guard: true if `error` is an {@link HttpError}. */
export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
