// src/http/body.ts — runtime-neutral body acquisition: limit resolution, parsing, and the failure
// envelope. The one part that is genuinely runtime-specific — getting the bytes — is supplied by
// the caller as a {@link BodyReader}.
import { HttpError, isHttpError } from '../signals';
import { renderError, type ErrorRequest } from '../transformers';
import { parseMultipart, extractBoundary, collapseDuplicates } from '../multipart';
import type { MatchedRoute, HttpOptions } from './types';

/** A ready-to-send error response produced while acquiring the request body. */
export interface BodyFailure {
  fail: { status: number; headers: Record<string, string>; body: string };
}

/** A value, or a promise of one. Readers that have nothing to await return the value directly. */
export type MaybePromise<T> = T | Promise<T>;

/** True for the native promises both adapters' readers return; no cross-realm thenables reach here. */
function isPromise<T>(value: MaybePromise<T>): value is Promise<T> {
  return value instanceof Promise;
}

/**
 * Reads the raw request body, enforcing `limit`.
 *
 * The adapter owns this and nothing else about the body, because enforcement is the one place the
 * runtimes legitimately differ: Node checks the running total as chunks arrive and can abort a
 * 10 GB upload after 1 MB, while a fetch runtime has only `request.arrayBuffer()` and can check
 * `byteLength` after the fact. Passing the limit *in*, rather than measuring the returned buffer
 * here, is what keeps Node's incremental abort — measuring afterwards would force it to buffer
 * without bound first.
 *
 * The failure branch is opaque on purpose: Node answers an over-limit request with
 * `connection: close`, so the rest of the upload does not keep arriving on a kept-alive socket.
 * That header means nothing on the fetch side, and is a forbidden response header on some
 * runtimes, so the adapter that needs it is the one that attaches it.
 *
 * `source` is the runtime's own request object, handed straight back untouched. It exists so the
 * reader can be built **once per server** instead of once per request: a closure capturing the
 * request measured at 250 ns per request together with the error-context object it captured —
 * more than the duplicate route resolution this whole indirection removes.
 */
export type BodyReader = (source: unknown, limit: number) => MaybePromise<{ bytes: Buffer | undefined } | BodyFailure>;

/** Parse outcome: the decoded body, or an error message plus the status to send (400 unless set). */
type ParseResult = { body: unknown } | { error: string; status?: number };

/**
 * Parses a raw request body by content type (JSON, urlencoded, multipart, or plain text).
 * @returns `{ body }` on success, or `{ error, status? }` on malformed input / missing multipart support.
 */
export async function parseRequestBody(
  buf: Buffer | undefined,
  contentType: string,
  duplicates: 'array' | 'last',
  maxParts: number,
): Promise<ParseResult> {
  if (buf !== undefined && contentType.includes('application/json')) {
    try {
      return { body: JSON.parse(buf.toString('utf8')) };
    } catch {
      return { error: 'Invalid JSON body' };
    }
  }

  if (buf !== undefined && contentType.includes('application/x-www-form-urlencoded')) {
    return { body: collapseDuplicates(new URLSearchParams(buf.toString('utf8')), duplicates) };
  }

  if (buf !== undefined && contentType.includes('multipart/form-data')) {
    const boundary = extractBoundary(contentType);
    if (!boundary) return { error: 'Invalid multipart body' };

    try {
      return { body: await parseMultipart(buf, boundary, { maxParts, duplicates }) };
    } catch (error) {
      // HttpError = the busboy peer dep is missing (501); anything else = malformed input (400).
      if (isHttpError(error)) return { error: error.message, status: error.status };
      return { error: 'Invalid multipart body' };
    }
  }

  const text = buf?.toString('utf8');
  return { body: text === '' ? undefined : text };
}

/**
 * Resolves the body limits for a matched route, reads it through `read`, and parses it.
 *
 * The four `route ?? server ?? default` chains below used to be written out in both adapters,
 * character for character, because each adapter had to route the request itself in order to know
 * whether to read a body — and so ended up owning every policy that depends on the matched route.
 * Adding a fifth knob, or changing one default, meant changing it in two places or letting the
 * runtimes quietly disagree about limits.
 */
export function acquireBody(
  read: BodyReader,
  source: unknown,
  matched: MatchedRoute,
  opts: HttpOptions | undefined,
  req: ErrorRequest,
): MaybePromise<{ body: unknown } | BodyFailure> {
  const limit = matched.def.maxBodyBytes ?? opts?.limits?.maxBodyBytes ?? 1_000_000;
  const acquired = read(source, limit);

  // Deliberately not `async`. A request with no body — every GET, which is most of them — resolves
  // this whole path without a single promise, and an `async` wrapper here would allocate one
  // regardless. Same reason `handle()` is not async.
  return isPromise(acquired)
    ? acquired.then((settled) => parseAcquired(settled, matched, opts, req))
    : parseAcquired(acquired, matched, opts, req);
}

function parseAcquired(
  acquired: { bytes: Buffer | undefined } | BodyFailure,
  matched: MatchedRoute,
  opts: HttpOptions | undefined,
  req: ErrorRequest,
): MaybePromise<{ body: unknown } | BodyFailure> {
  if ('fail' in acquired) return acquired;

  // `parseRequestBody(undefined, …)` answers `{ body: undefined }` for every content type, so
  // there is nothing to parse and nothing to await. Skipping it is what keeps a bodiless request
  // off the promise path entirely.
  if (acquired.bytes === undefined) return { body: undefined };

  const contentType = String(req.headers['content-type'] ?? '');
  const duplicates = matched.def.bodyDuplicates ?? opts?.bodyDuplicates ?? 'last';
  const maxParts = matched.def.maxParts ?? opts?.limits?.maxParts ?? 1000;

  return parseRequestBody(acquired.bytes, contentType, duplicates, maxParts).then((parsed) =>
    'error' in parsed
      ? { fail: renderError(new HttpError(parsed.status ?? 400, parsed.error), req, opts?.onError) }
      : { body: parsed.body },
  );
}
