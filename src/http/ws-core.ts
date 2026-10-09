import { isHttpError } from '../signals';
import type { Bus } from '../bus';
import { correlateRequest } from './core';
import { matchPattern } from './router';
import type { WsRouteDef, RequestLimits } from './types';

/** Neutral, runtime-free WebSocket request context (replaces the raw Node req). */
export interface WsRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  protocol: 'http' | 'https';
  ip: string;
}

/** Capability an adapter builds from its runtime socket. The neutral core talks only to this. */
export interface WsSocket {
  readonly inbound: AsyncIterable<unknown>;
  readonly abort: AbortSignal;
  readonly isOpen: boolean;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** Default for `limits.maxWsMessageBytes`: 1 MiB. */
export const DEFAULT_MAX_WS_MESSAGE_BYTES = 1_048_576;
/** Default for `limits.maxWsQueue`, in undelivered inbound messages per connection (D1). */
export const DEFAULT_MAX_WS_QUEUE = 16;

/**
 * Where `createApp` leaves the resolved `maxWsMessageBytes` for `serveBun`, which needs it as
 * Bun's native `maxPayloadLength` and has no other path to the app's options. Internal, not part
 * of the public `App` type; `Symbol.for` because each tsup entry carries its own copy of this
 * module, and only the global registry resolves to one symbol across them.
 */
export const WS_MAX_MESSAGE_BYTES: unique symbol = Symbol.for('green-tea.ws-max-message-bytes');

/** The effective `limits.maxWsMessageBytes`. */
export function wsMessageBytes(limits: Pick<RequestLimits, 'maxWsMessageBytes'> | undefined): number {
  return limits?.maxWsMessageBytes ?? DEFAULT_MAX_WS_MESSAGE_BYTES;
}

/** Throws when a WebSocket limit is present but not a positive safe integer (#107). */
export function validateWsLimits(limits: RequestLimits | undefined): void {
  for (const key of ['maxWsMessageBytes', 'maxWsQueue'] as const) {
    const value: unknown = limits?.[key];
    if (value === undefined || (Number.isSafeInteger(value) && (value as number) > 0)) continue;
    const shown = typeof value === 'string' ? `'${value}'` : String(value);
    throw new TypeError(`limits.${key} must be a positive integer, got ${shown}`);
  }
}

const encoder = new TextEncoder();

/** True when `msg`'s UTF-8 encoding is longer than `max` bytes. */
function exceedsBytes(msg: unknown, max: number): boolean {
  if (typeof msg !== 'string') return false; // every adapter delivers strings; nothing else to measure
  // A UTF-16 unit encodes to 1–3 UTF-8 bytes, so both bounds below are exact. Only a string in
  // between pays for the encode — which is never one of the short messages that dominate.
  if (msg.length * 3 <= max) return false;
  if (msg.length > max) return true;
  return encoder.encode(msg).byteLength > max;
}

/**
 * Bounds a socket's inbound side (#107): a frame over `maxWsMessageBytes` closes `1009`, and a
 * frame that arrives while `maxWsQueue` frames are still undelivered closes `1013`. Nothing is
 * dropped silently — the peer learns which bound it hit from the close code.
 *
 * Subscribes to `socket.inbound` immediately. `channel` is fan-out, so a frame pushed with no
 * subscriber is lost; subscribing here, before any boot or step runs, is what keeps the first
 * frames — for the mesh control channel, the `hello` itself. The returned socket's `inbound` is a
 * single-consumer FIFO over those frames, and every other capability is the original socket's.
 */
export function boundInbound(
  socket: WsSocket,
  limits?: Pick<RequestLimits, 'maxWsMessageBytes' | 'maxWsQueue'>,
): WsSocket {
  const fifo = new InboundFifo(socket, wsMessageBytes(limits), limits?.maxWsQueue ?? DEFAULT_MAX_WS_QUEUE);

  void fifo.pump();

  return Object.create(socket, {
    inbound: { value: { [Symbol.asyncIterator]: () => fifo } },
  }) as WsSocket;
}

/** The single-consumer queue behind {@link boundInbound}; it is its own async iterator. */
class InboundFifo implements AsyncIterator<unknown> {
  private readonly queue: unknown[] = [];
  private waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null = null;
  private ended = false;
  private failure: { err: unknown } | null = null;

  constructor(
    private readonly socket: WsSocket,
    private readonly maxBytes: number,
    private readonly maxQueue: number,
  ) {}

  async pump(): Promise<void> {
    try {
      for await (const msg of this.socket.inbound) {
        if (this.ended || !this.accept(msg)) break;
      }

      this.settle();
    } catch (err) {
      this.settle({ err });
    }
  }

  next(): Promise<IteratorResult<unknown>> {
    if (this.queue.length) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.failure) return Promise.reject(this.failure.err);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  // A consumer that stops reading has said it wants no more; queueing for it would only close
  // the connection for a bound it no longer cares about.
  return(): Promise<IteratorResult<unknown>> {
    this.queue.length = 0;
    this.settle();
    return Promise.resolve({ value: undefined, done: true });
  }

  /** Delivers or queues one frame; returns false once the frame has closed the socket. */
  private accept(msg: unknown): boolean {
    if (exceedsBytes(msg, this.maxBytes)) {
      this.socket.close(1009, 'message too large');
      return false;
    }

    const waiter = this.waiter;

    if (waiter) {
      this.waiter = null;
      waiter.resolve({ value: msg, done: false });
      return true;
    }

    if (this.queue.length >= this.maxQueue) {
      this.socket.close(1013, 'inbound queue full');
      return false;
    }

    this.queue.push(msg);
    return true;
  }

  /** Ends the queue once, cleanly or with a failure; whatever is still queued is delivered first. */
  private settle(failure?: { err: unknown }): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = failure ?? null;
    const waiter = this.waiter;
    this.waiter = null;
    if (!waiter) return;
    if (failure) waiter.reject(failure.err);
    else waiter.resolve({ value: undefined, done: true });
  }
}

/** Finds the first ws route whose pattern matches `path`, capturing its params. */
export function matchWsRoute(
  wsRoutes: WsRouteDef[],
  path: string,
): { def: WsRouteDef; params: Record<string, string> | undefined } | undefined {
  return wsRoutes
    .map((candidate) => ({ def: candidate, params: matchPattern(candidate.pattern, path) }))
    .find((entry) => entry.params);
}

/**
 * Runs `connection` with the socket registered for force-close on shutdown, unregistering it
 * when the connection ends. Without this a long-lived socket keeps `server.close()` waiting for
 * a peer that has no reason to hang up — the mesh control channel is exactly that shape.
 */
export async function trackUntil(
  socket: WsSocket,
  connection: Promise<void>,
  streams?: Set<() => void>,
): Promise<void> {
  const { closer } = trackConnection(socket, streams);

  try {
    await connection;
  } finally {
    streams?.delete(closer);
  }
}

/** Registers the connection with the stream registry so it can be force-closed on shutdown. */
function trackConnection(socket: WsSocket, streams?: Set<() => void>): { closer: () => void } {
  const closer = () => {
    try {
      socket.terminate();
    } catch {
      /* */
    }
  };

  streams?.add(closer);
  return { closer };
}

/** Drives the outbound async iterator, sending each yielded value until done or the socket closes. */
async function pumpOutbound(socket: WsSocket, iterator: AsyncIterator<unknown>): Promise<void> {
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    if (!socket.isOpen) break;
    socket.send(typeof value === 'string' ? value : JSON.stringify(value));
  }

  try {
    socket.close();
  } catch {
    /* already closed */
  }
}

/** Closes with 4000+status for HttpErrors, 1011 otherwise. */
function closeOnError(socket: WsSocket, err: unknown): void {
  if (isHttpError(err)) {
    const reason = new TextDecoder().decode(new TextEncoder().encode(String(err.message)).subarray(0, 120));

    try {
      socket.close(4000 + err.status, reason);
    } catch {
      /* already closed */
    }
  } else {
    try {
      socket.close(1011);
    } catch {
      /* already closed */
    }
  }
}

/** Runs the full per-connection lifecycle over a neutral socket capability. */
export async function runWsConnection(
  socket: WsSocket,
  request: WsRequest,
  route: { def: WsRouteDef; params: Record<string, string> | undefined },
  bus?: Bus,
  streams?: Set<() => void>,
): Promise<void> {
  const { closer } = trackConnection(socket, streams);
  const name = route.def.pattern;
  // Derived here rather than handed down: an upgrade is an HTTP request with headers like any
  // other, so it adopts an `x-request-id` from a gateway and carries `traceparent` through by the
  // same rule. `runWsConnection` is the only place a ws connection is correlated, which is what
  // keeps one identity per connection instead of one per emitter.
  const trace = { name, route: name, transport: 'ws', ...correlateRequest(request.headers) };
  let iterator: AsyncIterator<unknown> | undefined;

  const onAbort = () => {
    streams?.delete(closer);
    void Promise.resolve(iterator?.return?.()).catch(() => {});
  };

  socket.abort.addEventListener('abort', onAbort, { once: true });
  bus?.emit('stream:open', trace);

  try {
    const outbound = await route.def.open({
      params: route.params ?? {},
      inbound: socket.inbound,
      abort: socket.abort,
      req: request,
    });
    iterator = outbound[Symbol.asyncIterator]();
    await pumpOutbound(socket, iterator);
  } catch (err) {
    bus?.emit('stream:error', { ...trace, error: err });
    closeOnError(socket, err);
  } finally {
    bus?.emit('stream:close', trace);
  }
}
