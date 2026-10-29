// src/http/compression.ts — response compression (CARD-16, #112, D13 strategy B).
//
// The per-runtime contract, as measured in SPIKE-COMPRESSION.md and SPIKE-COMPRESSION-B.md:
//   - Node, Deno, Bun: `node:zlib` only, loaded lazily. Buffered bodies always go through the async
//     API: at 32 connections the sync API stalled the event loop for 9–13 ms even below 64 KiB, and
//     async gave 4× (Node) to 8× (Bun) the throughput. Streams go through createGzip /
//     createBrotliCompress, flushed after every frame, error frame and ping, so each event is
//     decodable the moment it arrives. br quality is fixed at 4 (zlib's default 11 stalls 6–33 ms).
//   - Deno runs `node:zlib`'s async API on the main thread (2.9.7), so there core compression is
//     CPU work on the event loop. That is documented, not worked around: no Deno branch here.
//   - Edge (workerd): core never encodes. Cloudflare compresses in front of the Worker, an encoded
//     body plus `Content-Encoding` is encoded a second time, and a bundled Worker cannot even
//     `require('node:zlib')`. Core sets `Vary` and nothing else.
//   - No `CompressionStream` anywhere: it cannot flush, so it would hold SSE frames back.
import { mergeVary } from '../security';
import { nodeRequire } from '../node-require';
import { findHeader } from './conditional';
import type { NeutralOutcome } from './core';

/** A content-coding core can produce. */
export type Encoding = 'br' | 'gzip';

/** The public `createApp({ compression })` object form. */
export interface CompressionOptions {
  /** Smallest buffered body, in bytes, worth encoding. Default `1024`. Streams ignore it. */
  threshold?: number;
  /** Encodings core may produce, in server preference order. Default `['br', 'gzip']`. */
  encodings?: Array<'br' | 'gzip'>;
}

/** Resolved, validated configuration. `encode: false` is the edge mode: `Vary` only. */
export interface CompressionConfig {
  threshold: number;
  encodings: Encoding[];
  encode: boolean;
}

/** Fixed brotli quality. See the module comment. */
export const BR_QUALITY = 4;

const KNOWN: readonly Encoding[] = ['br', 'gzip'];

/**
 * Marks an app as running on the edge, so core never encodes for it. `edgeHandler` calls it: that
 * covers the official adapter whatever the Worker's compat flags, including the case detection
 * cannot see (an old compat date without `navigator`, unbundled so `node:zlib` loads). A property
 * on the app rather than on the public `App` type, and `Symbol.for` because each tsup entry carries
 * its own copy of this module — the same arrangement as `WS_MAX_MESSAGE_BYTES`.
 */
export const MARK_EDGE: unique symbol = Symbol.for('green-tea.mark-edge');

/** The `[MARK_EDGE]` hook for an app: turns encoding off for good. A no-op when compression is off. */
export function edgeMarker(cfg: CompressionConfig | undefined): () => void {
  return () => {
    if (cfg) cfg.encode = false;
  };
}

/**
 * Whether this process is a Cloudflare Workers isolate. workerd sets `navigator.userAgent` to
 * exactly this string under the `global_navigator` compat flag, on by default since 2022-03-21.
 * Detected in `createApp` so `export default { fetch: app.fetch }`, which never passes through
 * `edgeHandler`, is covered too.
 */
export function isWorkerd(): boolean {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return nav?.userAgent === 'Cloudflare-Workers';
}

interface ZlibStream {
  write(chunk: Uint8Array | string): boolean;
  flush(kind: number, cb: () => void): void;
  end(): void;
  destroy(): void;
  on(event: string, fn: (...args: never[]) => void): this;
  once(event: string, fn: (...args: never[]) => void): this;
  pipe<T>(dest: T): T;
}

interface Zlib {
  gzip(b: Uint8Array, cb: (e: Error | null, r: Buffer) => void): void;
  brotliCompress(b: Uint8Array, o: object, cb: (e: Error | null, r: Buffer) => void): void;
  createGzip(): ZlibStream;
  createBrotliCompress(o: object): ZlibStream;
  constants: Record<string, number>;
}

let zlibModule: Zlib | undefined;
/** Lazy, so the edge bundle never evaluates `node:zlib`. */
const zlib = (): Zlib => (zlibModule ??= nodeRequire<Zlib>('node:zlib'));

/**
 * Encode only off workerd, and only where `node:zlib` actually loads. In a bundled Worker
 * `nodeRequire` throws, and without this probe every compressible edge response was a 500
 * (SPIKE-COMPRESSION-B §6.1). Evaluated once, at `createApp`.
 */
function canEncode(): boolean {
  if (isWorkerd()) return false;

  try {
    return typeof zlib().gzip === 'function';
  } catch {
    return false;
  }
}

/** Validates `createApp({ compression })`. Returns `undefined` when compression is off. */
export function resolveCompression(
  option: boolean | CompressionOptions | undefined,
  encode: () => boolean = canEncode,
): CompressionConfig | undefined {
  if (option === undefined || option === false) return undefined;

  if (option !== true && (typeof option !== 'object' || option === null))
    throw new TypeError('createApp({ compression }): expected a boolean or { threshold?, encodings? }');

  const opts: CompressionOptions = option === true ? {} : option;
  const threshold = opts.threshold ?? 1024;

  if (!Number.isInteger(threshold) || threshold < 0)
    throw new TypeError(
      `createApp({ compression }): threshold must be a non-negative integer, got ${String(threshold)}`,
    );

  const encodings = opts.encodings ?? ['br', 'gzip'];

  if (!Array.isArray(encodings) || encodings.length === 0)
    throw new TypeError('createApp({ compression }): encodings must be a non-empty array');

  for (const e of encodings)
    if (!KNOWN.includes(e))
      throw new TypeError(`createApp({ compression }): unknown encoding '${String(e)}' — expected 'br' or 'gzip'`);

  return { threshold, encodings: [...new Set(encodings)], encode: encode() };
}

/**
 * The qvalue grammar of RFC 9110 §12.4.2: `0` with up to three decimals, or `1` with up to three
 * zeros. `Number()` alone would admit `2`, `1e0` or `-1`, and a `q=2` would outrank the server's
 * preference.
 */
const QVALUE = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/;

/** `q` of one `Accept-Encoding` member, or 1 when absent. A malformed or out-of-range `q` excludes it. */
function weightOf(params: string[]): number {
  for (const param of params) {
    const eq = param.indexOf('=');

    if (eq !== -1 && param.slice(0, eq).trim().toLowerCase() === 'q') {
      const raw = param.slice(eq + 1).trim();
      return QVALUE.test(raw) ? Number(raw) : 0;
    }
  }

  return 1;
}

/**
 * `Accept-Encoding` negotiation (RFC 9110 §12.5.3). Returns the encoding to use, or `undefined` for
 * identity. Highest `q` wins; a tie goes to server preference, the order of `encodings`. `*` covers
 * every encoding not named explicitly, and `q=0` excludes. An absent header means identity:
 * §12.5.3 allows any coding then, but an absent header is overwhelmingly a client that would not
 * decode one.
 */
export function negotiate(accept: string | undefined, encodings: Encoding[]): Encoding | undefined {
  if (!accept) return undefined;
  const q = new Map<string, number>();

  for (const part of accept.split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = rawName.trim().toLowerCase();
    if (name) q.set(name, weightOf(params));
  }

  let best: Encoding | undefined;
  let bestQ = 0;

  for (const e of encodings) {
    const weight = q.get(e) ?? q.get('*') ?? 0;

    if (weight > bestQ) {
      best = e;
      bestQ = weight;
    }
  }

  return best;
}

const COMPRESSIBLE =
  /^\s*(text\/|application\/(json|javascript|xml|wasm|x-ndjson)\s*(;|$)|image\/svg\+xml\s*(;|$)|application\/[^;\s]+\+(json|xml)\s*(;|$))/i;

type Headers = Record<string, string | string[]>;

/**
 * Whether the response's representation could vary by `Accept-Encoding` at all. When it cannot —
 * already encoded, a range, no or an incompressible type, `no-transform` — core neither encodes
 * nor adds `Vary`. Request-side reasons (HEAD, the client's header) do not appear here: those
 * responses still get `Vary`, so a shared cache keys them correctly.
 */
function eligible(headers: Headers): boolean {
  // One pass over the keys rather than one `read` per header: every response with compression on
  // comes through here, and four case-insensitive scans plus two regexes cost ~8% of a small Deno
  // request. The first key of each name wins, as `findHeader` would pick it.
  let type: string | undefined;
  let cacheControl: string | undefined;

  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'content-encoding' || lower === 'content-range') return false;
    if (lower === 'content-type') type ??= Array.isArray(value) ? value.join(', ') : value;
    else if (lower === 'cache-control') cacheControl ??= Array.isArray(value) ? value.join(', ') : value;
  }

  if (!type || !compressibleType(type)) return false;
  return cacheControl === undefined || !NO_TRANSFORM.test(cacheControl);
}

const NO_TRANSFORM = /(^|[\s,])no-transform\s*(,|$)/i;

// ponytail: a one-entry memo, since an app answers nearly every response with the same type or two;
// a bounded map if a mix of types ever measures.
let lastType: string | undefined;
let lastCompressible = false;

function compressibleType(type: string): boolean {
  if (type !== lastType) {
    lastType = type;
    lastCompressible = COMPRESSIBLE.test(type);
  }

  return lastCompressible;
}

function withVary(headers: Headers): Headers {
  const key = findHeader(headers, 'vary');
  const out = { ...headers };
  let existing: string | undefined;

  if (key !== undefined) {
    const value = out[key];
    existing = Array.isArray(value) ? value.join(', ') : value;
    delete out[key];
  }

  out.vary = mergeVary(existing, 'Accept-Encoding');
  return out;
}

/** Headers for an encoded body: `Vary` merged, `Content-Encoding` set, `Content-Length` dropped (it described the identity body). */
function encodedHeaders(headers: Headers, encoding: Encoding): Headers {
  const out = withVary(headers);
  const length = findHeader(out, 'content-length');
  if (length !== undefined) delete out[length];
  out['content-encoding'] = encoding;
  return out;
}

const brParams = (size?: number) => {
  const c = zlib().constants;
  const params: Record<number, number> = { [c.BROTLI_PARAM_QUALITY]: BR_QUALITY };
  if (size !== undefined) params[c.BROTLI_PARAM_SIZE_HINT] = size;
  return { params };
};

/** Encodes one buffered body with the async zlib API — never the sync one (see the module comment). */
function encodeBody(body: Uint8Array, encoding: Encoding): Promise<Buffer> {
  const z = zlib();

  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (encoding === 'br') z.brotliCompress(body, brParams(body.byteLength), done);
    else z.gzip(body, done);
  });
}

/** A fresh compressing stream plus the flush mode that makes it emit everything written so far. */
function createEncoderStream(encoding: Encoding): { stream: ZlibStream; flushKind: number } {
  const z = zlib();

  if (encoding === 'br')
    return { stream: z.createBrotliCompress(brParams()), flushKind: z.constants.BROTLI_OPERATION_FLUSH };

  return { stream: z.createGzip(), flushKind: z.constants.Z_SYNC_FLUSH };
}

/** The request facts compression needs. */
export interface CompressionRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

const acceptOf = (req: CompressionRequest): string | undefined => {
  const v = req.headers['accept-encoding'];
  return Array.isArray(v) ? v.join(', ') : v;
};

type Buffered = Extract<NeutralOutcome, { kind: 'buffered' }>;
type Streamed = Extract<NeutralOutcome, { kind: 'stream' }>;

/** Decides a buffered outcome. Returns it untouched, with `Vary` only, or encoded. */
function compressBuffered(
  cfg: CompressionConfig,
  req: CompressionRequest,
  outcome: Buffered,
): Buffered | Promise<Buffered> {
  const { status, headers, body } = outcome;
  // A 304 carries `Vary` whatever else it has: it usually has no `Content-Type`, so the
  // eligibility test would drop it, and a cache needs the same key it stored the 200 under.
  if (status === 304) return { ...outcome, headers: withVary(headers) };
  if (status === 204 || !eligible(headers)) return outcome;

  const vary = { ...outcome, headers: withVary(headers) };
  if (status < 200 || req.method === 'HEAD' || !cfg.encode) return vary;

  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  if (bytes.byteLength < cfg.threshold) return vary;

  const encoding = negotiate(acceptOf(req), cfg.encodings);
  if (!encoding) return vary;

  return encodeBody(bytes, encoding).then((encoded) => ({
    ...outcome,
    headers: encodedHeaders(headers, encoding),
    body: encoded,
  }));
}

/** Decides a stream: its headers, and the encoding the adapter applies frame by frame. `threshold` does not apply. */
function compressStream(cfg: CompressionConfig, req: CompressionRequest, outcome: Streamed): Streamed {
  if (!eligible(outcome.headers)) return outcome;
  if (req.method === 'HEAD' || !cfg.encode) return { ...outcome, headers: withVary(outcome.headers) };
  const encoding = negotiate(acceptOf(req), cfg.encodings);
  if (!encoding) return { ...outcome, headers: withVary(outcome.headers) };
  return { ...outcome, headers: encodedHeaders(outcome.headers, encoding), encoding };
}

/**
 * Applies `createApp({ compression })` to an outcome, after `handle()` and before the adapter
 * writes it. One function for both adapters, so Node and the fetch runtimes cannot diverge. The
 * ETag (CARD-15) was taken in `dispatch` on the identity body and is not touched: it is weak, so
 * one tag describes every coding.
 */
export function compressOutcome(
  cfg: CompressionConfig | undefined,
  req: CompressionRequest,
  outcome: NeutralOutcome,
): NeutralOutcome | Promise<NeutralOutcome> {
  if (!cfg) return outcome;
  return outcome.kind === 'stream' ? compressStream(cfg, req, outcome) : compressBuffered(cfg, req, outcome);
}

/**
 * Wraps a web byte stream so every chunk is compressed and flushed on its own: one SSE frame in,
 * one decodable compressed chunk out. This is the thing `CompressionStream` cannot do.
 */
export function compressWebStream(source: ReadableStream<Uint8Array>, encoding: Encoding): ReadableStream<Uint8Array> {
  const { stream: z, flushKind } = createEncoderStream(encoding);
  const reader = source.getReader();
  let pending: Uint8Array[] = [];
  let failure: unknown;
  z.on('data', (c: Uint8Array) => pending.push(c));
  // Without a listener a zlib error is an uncaught exception that takes the process down.
  z.on('error', (err: unknown) => (failure ??= err));

  const take = (): Uint8Array | undefined => {
    if (pending.length === 0) return undefined;
    const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending);
    pending = [];
    return new Uint8Array(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();

      if (done) {
        await new Promise<void>((resolve) => {
          z.once('end', resolve);
          z.once('error', () => resolve());
          z.end();
        });
      } else {
        z.write(value);
        await new Promise<void>((resolve) => z.flush(flushKind, resolve));
      }

      if (failure !== undefined) {
        controller.error(failure);
        await reader.cancel(failure).catch(() => {});
        return;
      }

      const out = take();
      if (out) controller.enqueue(out);
      if (done) controller.close();
    },
    async cancel(reason) {
      z.destroy();
      await reader.cancel(reason);
    },
  });
}

/** Where `pipeStream` writes frames: `res` itself, or a flushing compressor piped into it. */
export interface FrameSink {
  write(chunk: string | Buffer): boolean;
  /** The emitter whose `drain` ends a backpressure wait. */
  drains: NodeJS.EventEmitter;
  end(): void;
  destroy(): void;
}

/** The Node stream path's sink. Without an encoding it is `res`, unchanged. */
export function frameSink(res: NodeJS.WritableStream & { destroy(): void }, encoding?: Encoding): FrameSink {
  if (!encoding) return { write: (c) => res.write(c), drains: res, end: () => void res.end(), destroy: () => {} };

  const { stream: zs, flushKind } = createEncoderStream(encoding);
  zs.on('error', () => res.destroy());
  zs.pipe(res);

  return {
    write(chunk) {
      const ok = zs.write(chunk);
      // Flushed per frame: the point of an event stream is that each event arrives when it happens.
      zs.flush(flushKind, () => {});
      return ok;
    },
    drains: zs as unknown as NodeJS.EventEmitter,
    end: () => zs.end(), // `pipe` ends `res` once the compressor has drained
    destroy: () => zs.destroy(),
  };
}
