import type { StreamEncoder } from '../encoders';
import { createRequestGate } from './request-gate';
import { handle, computeInjected, correlateRequest, type HandleResult, type Preflight } from './core';
import { mergeInjectedHeaders } from './headers';
import type { BodyFailure, BodyReader, MaybePromise } from './body';
import { HttpError } from '../signals';
import { renderError, type ErrorRequest } from '../transformers';
import type { RouteDef, HttpOptions } from './types';

/** Wraps an AsyncIterable as a web ReadableStream, encoding each value. Cancels the source on stream cancel. */
export function asReadableStream(source: AsyncIterable<unknown>, encoder: StreamEncoder): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const te = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();

        if (done) {
          controller.close();
          return;
        }

        const encoded = encoder.encode(value);
        const bytes = typeof encoded === 'string' ? te.encode(encoded) : encoded;
        controller.enqueue(bytes);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** Converts a web `Headers` into the plain record shape the neutral core and body parser expect. */
function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * The fetch half of body acquisition: bytes out of the `Request`, and the over-limit answer.
 *
 * Unlike Node, there is no incremental read to abort — `arrayBuffer()` resolves with the whole body
 * or not at all, so the limit can only be checked once the bytes are already in memory. That
 * difference is exactly why the limit is passed in rather than applied by the shared core.
 */
function readFetchBytes(
  source: unknown,
  limit: number,
  opts: HttpOptions | undefined,
): MaybePromise<{ bytes: Buffer | undefined } | BodyFailure> {
  const request = source as Request;
  // Not `async`: a bodiless request answers without allocating a promise at all.
  if (!request.body) return { bytes: undefined };

  return request.arrayBuffer().then((arrayBuffer) => {
    if (arrayBuffer.byteLength > limit) {
      // Rebuilt here rather than captured per request: only an over-limit body ever needs it, and
      // a `url`/`headers` pair captured up-front cost more than the work it saved.
      const url = new URL(request.url);
      const errReq: ErrorRequest = {
        method: request.method,
        url: url.pathname + url.search,
        headers: headersToRecord(request.headers),
      };
      return { fail: renderError(new HttpError(413, 'Payload Too Large'), errReq, opts?.onError) };
    }

    return { bytes: arrayBuffer.byteLength === 0 ? undefined : Buffer.from(arrayBuffer) };
  });
}

/**
 * Whatever the host runtime's `Response` accepts as a body. Derived from the constructor rather
 * than written as `BodyInit`, because that name is not global under this `lib` (`es2020` plus
 * `@types/node`) even though `Response` itself is — and Deno spells the same idea from its own lib.
 */
type ResponseBody = ConstructorParameters<typeof Response>[0];

/**
 * Narrows a buffered body to something the runtime's `Response` accepts.
 *
 * A Node `Buffer` is a `Uint8Array` at runtime, so every runtime here takes one — but its declared
 * backing store is `ArrayBufferLike`, which admits `SharedArrayBuffer`, and `BodyInit` accepts only
 * `ArrayBuffer`-backed views. Deno's lib therefore rejects it outright: this is the `app.fetch` path,
 * so the mismatch reaches Deno, Bun and edge alike. Node never allocates a Buffer over a
 * `SharedArrayBuffer`, which is what makes the assertion on the backing store safe to state.
 *
 * `byteOffset`/`byteLength` are load-bearing, not defensive. `Buffer.from` and `Buffer.allocUnsafe`
 * hand back a window into a shared 8 KB pool, so re-viewing the backing store without them yields
 * the whole pool — neighbouring allocations included. Today the only Buffer reaching here comes from
 * `fs.promises.readFile`, which returns an exactly-sized allocation, so nothing currently trips that.
 * `StaticHit.body` is typed `Buffer` though, and a pooled one is a correct value for it.
 *
 * Re-viewing rather than copying: this is the buffered-response path, and a copy per response would
 * be a real cost on the runtimes that have no other adapter.
 */
export function toBodyInit(body: string | Buffer): ResponseBody {
  if (typeof body === 'string') return body;
  return new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
}

/** Converts a {@link HandleResult}'s outcome into a web `Response`, buffered or streamed. */
function outcomeToResponse(result: HandleResult): Response {
  const headers = mergeInjectedHeaders(result.outcome.headers, result.injected) as Record<string, string>;

  if (result.outcome.kind === 'stream') {
    return new Response(asReadableStream(result.outcome.stream, result.outcome.encoder), { headers });
  }

  const body = [204, 205, 304].includes(result.outcome.status) ? null : toBodyInit(result.outcome.body);
  return new Response(body, { status: result.outcome.status, headers });
}

/**
 * Builds a Web-Standards `fetch(request)` handler over the same route table the Node adapter uses:
 * describes the request for the runtime-neutral {@link handle}, supplies the {@link BodyReader} it
 * calls once a route matches, and converts the outcome to a `Response` (buffered or streamed).
 * Routing, body parsing, limits and error rendering all live in the core; this file is the part
 * that knows how to get bytes out of a `Request` and how to put them into a `Response`.
 */
export function buildFetch(routes: RouteDef[], opts: HttpOptions | undefined) {
  // Built once per server, not once per request — see `BodyReader`.
  const readBody: BodyReader = (source, limit) => readFetchBytes(source, limit, opts);
  const gate = createRequestGate(opts?.limits?.maxConcurrentRequests);

  return async (request: Request): Promise<Response> => {
    if (!gate.acquire()) {
      return new Response('Service Unavailable', {
        status: 503,
        headers: { 'retry-after': '1' },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const headers = headersToRecord(request.headers);
    // Derived before the body is read, so a 413 rejected below still carries an identity.
    const correlation = correlateRequest(headers);
    const secure = url.protocol === 'https:';
    // Computed up-front from the same inputs `handle()` uses, so a preflight — the one response
    // this adapter builds itself — carries the same security/CORS headers every other one does.
    const injected = computeInjected(opts, { secure, headers });

    let result: HandleResult | Preflight;

    try {
      result = await handle(routes, opts, {
        ...correlation,
        method: request.method,
        url: path,
        headers,
        readBody,
        source: request,
        secure,
        // Mirrors Node's `deriveIp` (src/http/request.ts): only trust `x-forwarded-for` when the proxy is
        // trusted, and take its first hop — an untrusted XFF is client-spoofable, and there's no socket
        // peer address to fall back to on the fetch path, so the untrusted case is simply ''.
        ip: opts?.trustProxy
          ? String(headers['x-forwarded-for'] ?? '')
              .split(',')[0]
              .trim()
          : '',
      });
    } finally {
      // Release when routing/handling finishes, not when a returned stream finishes.
      // Long-lived streams therefore do not permanently consume the request budget.
      gate.release();
    }

    // Mirrors the Node adapter, where `result.preflight` is written through the writeHead patch and
    // so picks up the same authoritative security headers `injected` carries.
    if ('preflight' in result) {
      return new Response(null, {
        status: 204,
        headers: mergeInjectedHeaders(result.preflight, injected),
      });
    }

    return outcomeToResponse(result);
  };
}
