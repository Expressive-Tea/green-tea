import type { StreamEncoder } from '../encoders';
import { handle, computeInjected, type HandleResult } from './core';
import { mergeInjectedHeaders } from './headers';
import { parseRequestBody } from './server';
import { normalizeRequestPath, resolveRoute } from './router';
import { HttpError } from '../signals';
import { renderError, type ErrorRequest, type ErrorResponse } from '../transformers';
import type { RouteDef, HttpOptions, MatchedRoute } from './types';

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
 * Turns a rendered error (or any {status, headers, body}) into a web `Response`, merging in the
 * authoritative `injected` security/CORS headers — mirrors the Node adapter, where
 * `patchResponseHeaders` installs these before body acquisition even runs, so early failures
 * (413/400/501) carry them too.
 */
function errorResponse(rendered: ErrorResponse, injected: Record<string, string>): Response {
  const headers = mergeInjectedHeaders(rendered.headers, injected);
  return new Response(rendered.body, { status: rendered.status, headers });
}

/**
 * Reads and parses a matched request's body (enforcing `maxBodyBytes` → 413), mirroring the Node
 * adapter's `acquireBody`. Returns `{ body }` on success, or a ready-to-send `{ response }` on failure.
 */
async function acquireFetchBody(
  request: Request,
  matched: MatchedRoute,
  headers: Record<string, string>,
  path: string,
  maxBody: number,
  opts: HttpOptions | undefined,
  injected: Record<string, string>,
): Promise<{ body: unknown } | { response: Response }> {
  const errReq: ErrorRequest = { method: request.method, url: path, headers };
  let buf: Buffer | undefined;

  if (request.body) {
    const arrayBuffer = await request.arrayBuffer();
    const bodyLimit = matched.def.maxBodyBytes ?? maxBody;

    if (arrayBuffer.byteLength > bodyLimit) {
      return {
        response: errorResponse(renderError(new HttpError(413, 'Payload Too Large'), errReq, opts?.onError), injected),
      };
    }

    buf = arrayBuffer.byteLength === 0 ? undefined : Buffer.from(arrayBuffer);
  }

  const contentType = headers['content-type'] ?? '';
  const duplicates = matched.def.bodyDuplicates ?? opts?.bodyDuplicates ?? 'last';
  const maxParts = matched.def.maxParts ?? opts?.limits?.maxParts ?? 1000;
  const parsed = await parseRequestBody(buf, contentType, duplicates, maxParts);

  if ('error' in parsed) {
    return {
      response: errorResponse(
        renderError(new HttpError(parsed.status ?? 400, parsed.error), errReq, opts?.onError),
        injected,
      ),
    };
  }

  return { body: parsed.body };
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
 * reads the body (enforcing `maxBodyBytes` → 413), parses it by content type, runs it through the
 * runtime-neutral {@link handle}, and converts the outcome to a `Response` (buffered or streamed).
 */
export function buildFetch(routes: RouteDef[], opts: HttpOptions | undefined) {
  const maxBody = opts?.limits?.maxBodyBytes ?? 1_000_000;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname + url.search;
    const headers = headersToRecord(request.headers);
    let matched: ReturnType<typeof resolveRoute>;

    try {
      matched = resolveRoute(routes, request.method, normalizeRequestPath(url.pathname));
    } catch {
      matched = undefined; // handle() renders the shared 400 response without reading a body
    }

    const secure = url.protocol === 'https:';
    // Computed up-front from the same inputs `handle()` uses, so early-failure responses (413/400/501,
    // before a route handler even runs) carry the same security/CORS headers Node's writeHead patch
    // would have installed before body acquisition.
    const injected = computeInjected(opts, { secure, headers });
    let body: unknown;

    if (matched) {
      const acquired = await acquireFetchBody(request, matched, headers, path, maxBody, opts, injected);
      if ('response' in acquired) return acquired.response;
      body = acquired.body;
    }

    const result = await handle(routes, opts, {
      method: request.method,
      url: path,
      headers,
      body,
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

    // Mirrors the Node adapter, where `result.preflight` is written through the writeHead patch and
    // so picks up the same authoritative security headers `injected` carries (Node's writeHead patch
    // merges every response — including the 204 preflight — with `injected`; this adapter must too).
    if ('preflight' in result) {
      return new Response(null, { status: 204, headers: mergeInjectedHeaders(result.preflight, injected) });
    }

    return outcomeToResponse(result);
  };
}
