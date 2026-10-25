// src/http/body.ts — runtime-neutral body acquisition: limit resolution, parsing, and the failure
// envelope. The one part that is genuinely runtime-specific — getting the bytes — is supplied by
// the caller as a {@link BodyReader}.
import { HttpError, isHttpError } from '../signals';
import { renderError, type ErrorRequest } from '../transformers';
import { parseMultipart, extractBoundary, collapseDuplicates } from '../multipart';
import type { MatchedRoute, HttpOptions } from './types';

/** A ready-to-send error response produced while acquiring the request body. */
export interface BodyFailure {
  fail: { status: number; headers: Record<string, string | string[]>; body: string };
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
 * The adapter owns this and nothing else about the body, because getting the bytes is the one place
 * the runtimes legitimately differ: Node iterates the socket, a fetch runtime reads `request.body`.
 * Both check the running total as chunks arrive and abort a 10 GB upload after 1 MB. Passing the
 * limit *in*, rather than measuring the returned buffer here, is what makes that incremental abort
 * possible — measuring afterwards would force the reader to buffer without bound first.
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

/**
 * True when a `content-length` header declares more than `limit` bytes — the one case a reader can
 * refuse before consuming anything. A malformed or absent header answers false: it proves nothing,
 * and the running total still enforces the limit on whatever actually arrives.
 */
export function declaresOverLimit(contentLength: string | null | undefined, limit: number): boolean {
  return contentLength != null && /^\d+$/.test(contentLength) && Number(contentLength) > limit;
}

/**
 * The media type of a Content-Type value: the part before any parameters, trimmed and lowercased,
 * since media types are case-insensitive (RFC 9110 §8.3.1). Matching a substring of the raw header
 * instead let a parameter choose the parser: `text/plain; x=application/json` was parsed as JSON.
 */
function mediaType(contentType: string): string {
  const semi = contentType.indexOf(';');
  return (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

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
  maxFieldBytes?: number,
): Promise<ParseResult> {
  const type = mediaType(contentType);

  // `+json` is the structured-syntax suffix for JSON (RFC 6839): `application/problem+json`,
  // `application/vnd.api+json` and `application/json-patch+json` are JSON documents too.
  if (buf !== undefined && (type === 'application/json' || type.endsWith('+json'))) {
    try {
      return { body: JSON.parse(buf.toString('utf8')) };
    } catch {
      return { error: 'Invalid JSON body' };
    }
  }

  if (buf !== undefined && type === 'application/x-www-form-urlencoded') {
    return { body: collapseDuplicates(new URLSearchParams(buf.toString('utf8')), duplicates) };
  }

  if (buf !== undefined && type === 'multipart/form-data') {
    const boundary = extractBoundary(contentType);
    if (!boundary) return { error: 'Invalid multipart body' };

    try {
      return { body: await parseMultipart(buf, boundary, { maxParts, duplicates, maxFieldBytes }) };
    } catch (error) {
      // HttpError = the busboy peer dep is missing (501) or a field is over the limit (413);
      // anything else = malformed input (400).
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
    ? acquired.then((settled) => parseAcquired(settled, limit, matched, opts, req))
    : parseAcquired(acquired, limit, matched, opts, req);
}

function parseAcquired(
  acquired: { bytes: Buffer | undefined } | BodyFailure,
  limit: number,
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

  // A field is bounded by the body limit alone. busboy's own 1 MiB default would otherwise cut any
  // larger field that `maxBodyBytes` was raised to admit.
  return parseRequestBody(acquired.bytes, contentType, duplicates, maxParts, limit).then((parsed) =>
    'error' in parsed
      ? { fail: renderError(new HttpError(parsed.status ?? 400, parsed.error), req, opts?.onError, opts?.logger) }
      : { body: parsed.body },
  );
}
