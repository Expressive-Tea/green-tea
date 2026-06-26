export class HttpError extends Error {
  constructor(readonly status: number, message?: string, readonly body?: unknown) {
    super(message ?? `HTTP ${status}`);
    this.name = new.target.name;
  }
}

export class Unauthorized extends HttpError {
  constructor(message?: string) { super(401, message); }
}

export class NotFound extends HttpError {
  constructor(message?: string) { super(404, message); }
}

export class NotModified extends HttpError {
  constructor() { super(304); }
}

export class Redirect extends HttpError {
  constructor(readonly location: string) { super(302); }
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError;
}
