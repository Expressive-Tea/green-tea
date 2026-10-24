import type { StreamEncoder } from '../encoders';
import type { Bus, Correlation } from '../bus';
import { createRequestGate } from './request-gate';
import {
  handle,
  computeInjected,
  correlateRequest,
  emitShedPair,
  watchingRequests,
  type HandleResult,
  type Preflight,
} from './core';
import { mergeInjectedHeaders, toWebHeaders } from './headers';
import { peerOf, trustedProxyClient } from './peer';
import { declaresOverLimit, type BodyFailure, type BodyReader, type MaybePromise } from './body';
import { HttpError } from '../signals';
import { renderError, type ErrorRequest } from '../transformers';
import type { RouteTable, HttpOptions } from './types';
import { answerProbe } from './health';
import { currentRoutes } from './router';
import { compressOutcome, compressWebStream } from './compression';
import type { NeutralOutcome } from './core';
import { releaseIterator } from '../channel';

/**
 * Wraps an AsyncIterable as a web ReadableStream, encoding each value. Cancels the source on stream
 * cancel, and reports the connection on the bus exactly as {@link pipeStream} does for Node — the
 * lifecycle of a stream must not depend on which adapter is serving it.
 */
export function asReadableStream(
  source: AsyncIterable<unknown>,
  encoder: StreamEncoder,
  bus?: Bus,
  name = '',
  correlation: Correlation = {},
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const te = new TextEncoder();
  // See the same line in `pipeStream`: `name` is the pattern on a stream event, but the contract
  // says label on `route`, so both are carried.
  const trace = { name, route: name, ...correlation };
  const frame = (chunk: string | Buffer): Uint8Array => (typeof chunk === 'string' ? te.encode(chunk) : chunk);
  // `cancel` can land after the body has already ended, and an errored stream still unwinds through
  // its own path — so the close is latched rather than emitted from each of the three exits.
  let closed = false;
  // Settles on `cancel`, so a `pull` waiting on an idle source's `next()` stops waiting (GitHub #40).
  let cancelled!: (step: undefined) => void;
  const gone = new Promise<undefined>((resolve) => (cancelled = resolve));

  const close = (): void => {
    if (closed) return;
    closed = true;
    bus?.emit('stream:close', trace);
  };

  return new ReadableStream<Uint8Array>({
    start() {
      bus?.emit('stream:open', trace);
    },
    async pull(controller) {
      try {
        const step = await Promise.race([iterator.next(), gone]);
        if (!step) return;
        const { value, done } = step;

        if (done) {
          close();
          controller.close();
          return;
        }

        controller.enqueue(frame(encoder.encode(value)));
      } catch (err) {
        bus?.emit('stream:error', { ...trace, error: err });
        const errorFrame = encoder.encodeError(err);
        close();

        // Framed and closed cleanly, which is what the Node adapter does and the better answer for
        // the client: an SSE consumer that received an `error` event knows what happened, where a
        // transport-level failure is indistinguishable from the connection simply dropping.
        // `controller.error` is kept for the encoder that has no error frame to offer, because
        // then breaking the stream is the only signal left.
        if (errorFrame === null) {
          controller.error(err);
          return;
        }

        controller.enqueue(frame(errorFrame));
        controller.close();
      }
    },
    // Not awaited: `return()` on a generator still waiting in `next()` would hold the cancel open.
    cancel() {
      close();
      cancelled(undefined);
      releaseIterator(iterator);
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
 * Read from `request.body` chunk by chunk rather than through `arrayBuffer()`, which resolves with
 * the whole body or not at all and so could only check the limit once every byte was in memory.
 * Deno, Bun, workerd and Node all expose `request.body` as a stream, so no runtime needs a branch.
 */
function readFetchBytes(
  source: unknown,
  limit: number,
  opts: HttpOptions | undefined,
): MaybePromise<{ bytes: Buffer | undefined } | BodyFailure> {
  const request = source as Request;
  // Not `async`: a bodiless request answers without allocating a promise at all.
  if (!request.body) return { bytes: undefined };

  // A declared length over the limit is refused before a single chunk is pulled. Cancelling is best
  // effort: it tells the runtime to stop the upload, and a refusal changes nothing about the answer.
  if (declaresOverLimit(request.headers.get('content-length'), limit)) {
    request.body.cancel().catch(() => {});
    return tooLarge(request, opts);
  }

  // ponytail: one reader loop; a TransformStream byte-counter only if another consumer needs it
  return readBounded(request.body.getReader(), limit).then((bytes) =>
    bytes === null ? tooLarge(request, opts) : { bytes },
  );
}

/**
 * Reads until the stream ends, or until the running total crosses `limit` — then cancels the reader,
 * so no further chunk is pulled, and answers null. A rejected `read()` (the client went away)
 * propagates exactly as a rejected `arrayBuffer()` used to.
 *
 * workerd may strip `content-length` from a chunked upload, so there this count is the only check.
 * The answer is the same 413 either way; only how early it comes differs.
 */
async function readBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
): Promise<Buffer | undefined | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;

    if (total > limit) {
      reader.cancel().catch(() => {});

      return null;
    }

    chunks.push(value);
  }

  return total === 0 ? undefined : Buffer.concat(chunks, total);
}

/** The over-limit answer, shared by the declared-length check and the stream count. */
function tooLarge(request: Request, opts: HttpOptions | undefined): BodyFailure {
  // Rebuilt here rather than captured per request: only an over-limit body ever needs it, and
  // a `url`/`headers` pair captured up-front cost more than the work it saved.
  const url = new URL(request.url);
  const errReq: ErrorRequest = {
    method: request.method,
    url: url.pathname + url.search,
    headers: headersToRecord(request.headers),
  };
  return { fail: renderError(new HttpError(413, 'Payload Too Large'), errReq, opts?.onError, opts?.logger) };
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

/** Converts an outcome (already through `compressOutcome`) into a web `Response`, buffered or streamed. */
function outcomeToResponse(
  outcome: NeutralOutcome,
  injected: Record<string, string>,
  bus?: Bus,
  correlation: Correlation = {},
): Response {
  const headers = toWebHeaders(mergeInjectedHeaders(outcome.headers, injected));

  if (outcome.kind === 'stream') {
    const frames = asReadableStream(outcome.stream, outcome.encoder, bus, outcome.route, correlation);
    return new Response(outcome.encoding ? compressWebStream(frames, outcome.encoding) : frames, { headers });
  }

  const body = [204, 205, 304].includes(outcome.status) ? null : toBodyInit(outcome.body);
  return new Response(body, { status: outcome.status, headers });
}

/** The first `x-forwarded-for` hop when the proxy is trusted, else `''`. */
function forwardedFor(headers: Record<string, string>, opts: HttpOptions | undefined): string {
  if (!opts?.trustProxy) return '';

  return String(headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim();
}

/**
 * Builds a Web-Standards `fetch(request)` handler over the same route table the Node adapter uses:
 * describes the request for the runtime-neutral {@link handle}, supplies the {@link BodyReader} it
 * calls once a route matches, and converts the outcome to a `Response` (buffered or streamed).
 * Routing, body parsing, limits and error rendering all live in the core; this file is the part
 * that knows how to get bytes out of a `Request` and how to put them into a `Response`.
 */
export function buildFetch(routes: RouteTable, opts: HttpOptions | undefined) {
  // Built once per server, not once per request — see `BodyReader`.
  const readBody: BodyReader = (source, limit) => readFetchBytes(source, limit, opts);
  const gate = createRequestGate(opts?.limits?.maxConcurrentRequests);

  return async (request: Request): Promise<Response> => {
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
    let acquired = false;
    const watching = watchingRequests(opts?.bus);
    const startedAt = watching ? performance.now() : 0;

    try {
      if (!gate.acquire()) {
        if (watching)
          emitShedPair(
            opts!.bus!,
            {
              method: request.method,
              url: path,
              requestId: correlation.requestId,
              traceId: correlation.traceId,
            },
            startedAt,
          );

        return new Response(JSON.stringify({ error: 'Service Unavailable' }), {
          status: 503,
          headers: toWebHeaders(
            mergeInjectedHeaders(
              {
                'content-type': 'application/json',
                'retry-after': '1',
              },
              injected,
            ),
          ),
        });
      }

      acquired = gate.limited;

      result = await handle(
        // Read once per request: a mesh teacup swaps its table when peers come and go, and one
        // request must route and build `Allow` against the same table (CARD-19).
        currentRoutes(routes),
        opts,
        {
          ...correlation,
          method: request.method,
          url: path,
          headers,
          readBody,
          source: request,
          secure,
          // Mirrors Node's `deriveIp` (src/http/request.ts): only trust `x-forwarded-for` when the
          // proxy is trusted, and take its first hop — an untrusted XFF is client-spoofable.
          // Otherwise the socket peer, which only the Deno and Bun adapters can supply; a bare
          // `app.fetch` has none, so there the answer is still ''.
          // Ahead of both, under `trustProxy` only: the address the edge adapter read from
          // `cf-connecting-ip`. Cloudflare sets that header itself, while XFF can carry hops the
          // client supplied, so on the edge it wins (CARD-23).
          ip: trustedProxyClient(request, opts?.trustProxy) || forwardedFor(headers, opts) || peerOf(request),
        },
        // Already computed above for the shed-503 path; handing it down keeps `cors.origins` to
        // one call per request.
        injected,
      );
    } finally {
      // Release when routing/handling finishes, not when a returned stream finishes.
      // Long-lived streams therefore do not permanently consume the request budget.
      if (acquired) gate.release();
    }

    // Mirrors the Node adapter, where `result.preflight` is written through the writeHead patch and
    // so picks up the same authoritative security headers `injected` carries.
    if ('preflight' in result) {
      return new Response(null, {
        status: 204,
        headers: toWebHeaders(mergeInjectedHeaders(result.preflight, injected)),
      });
    }

    const decided = compressOutcome(opts?.compression, { method: request.method, headers }, result.outcome);
    return decided instanceof Promise
      ? decided.then((outcome) => outcomeToResponse(outcome, injected, opts?.bus, correlation))
      : outcomeToResponse(decided, injected, opts?.bus, correlation);
  };
}

/**
 * Answers a health probe through the Fetch API, or returns `undefined` for any other request (or when
 * `health` is off). `app.fetch` calls this before awaiting the boot, which is what lets `/__ready__`
 * report `booting` at all, and before the gate and `handle()`, for the same reasons as the Node adapter.
 */
export function answerFetchProbe(request: Request, opts: HttpOptions | undefined): Response | undefined {
  if (!opts?.health) return undefined;

  const url = new URL(request.url);
  const probe = answerProbe(request.method, url.pathname + url.search, opts.health);
  if (!probe) return undefined;

  const injected = computeInjected(opts, {
    secure: url.protocol === 'https:',
    headers: headersToRecord(request.headers),
  });
  return new Response(probe.body || null, {
    status: probe.status,
    headers: mergeInjectedHeaders(probe.headers, injected) as Record<string, string>,
  });
}
