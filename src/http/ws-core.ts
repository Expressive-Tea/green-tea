import { isHttpError } from '../signals';
import { CHANNEL_TAP, type TappableChannel } from '../channel';
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
  /**
   * Resolves once the socket's send buffer is at or below the adapter's high-water mark, or the
   * socket has closed — at once when it already is (#41). The outbound pump awaits it before
   * pulling the next value, so a fast producer cannot grow the buffer without limit.
   *
   * Optional: a socket without it is never waited on, which is how every socket behaved before.
   * The mark is the adapter's; {@link WS_HIGH_WATER_MARK} is what the built-in adapters use.
   */
  drained?(): Promise<void>;
}

/**
 * Send-buffer level, in bytes, above which the built-in adapters report a socket as backed up
 * (#41). Internal, not an option: it bounds what one slow peer can make the process hold, and
 * a frame is sent whole, so the buffer peaks at this plus one frame.
 */
export const WS_HIGH_WATER_MARK = 1_048_576;

/** The tail of each socket's {@link sendWhenDrained} queue. */
const sendQueues = new WeakMap<WsSocket, Promise<void>>();

/**
 * Sends on `socket` in call order, each frame only once {@link WsSocket.drained} lets it (#41).
 * For senders outside the outbound pump, such as concurrent mesh RPCs. Waiting one at a time is
 * the point: callers that each waited on their own would all be released by the same drain and
 * all send, putting one frame per caller over the mark. Queued, the buffer peaks at the mark plus
 * one frame, however many callers wait.
 *
 * `frame` runs at send time, so a caller that settled while queued (a timeout) returns
 * `undefined` and sends nothing. Nothing is sent once the socket has closed.
 */
export function sendWhenDrained(socket: WsSocket, frame: () => string | undefined): Promise<void> {
  const sent = (sendQueues.get(socket) ?? Promise.resolve()).then(async () => {
    if (socket.drained) await socket.drained();
    if (socket.abort.aborted) return;
    const data = frame();
    if (data !== undefined) socket.send(data);
  });
  sendQueues.set(
    socket,
    sent.catch(() => {}),
  );
  return sent;
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

/**
 * Undelivered inbound frames the mesh control channel may hold once its peer is authenticated
 * (#148), in place of `limits.maxWsQueue` when larger. Its consumer, the teapot's frame loop, never
 * awaits between frames, so its queue only ever holds one delivery burst: `ws` emits every frame of
 * one socket read synchronously, and a read is at most 64 KiB, under 4,096 of the smallest control
 * frame (`{"type":"ping"}`). A teacup with many RPCs in flight sends exactly such bursts, which the
 * 16-frame user default closed with 1013.
 */
const CONTROL_QUEUE = 4096;

/**
 * Largest frame the mesh control channel accepts before its peer's `hello` is accepted. A hello
 * is a version and a secret; nothing larger has a reason to arrive first.
 */
export const HELLO_FRAME_BYTES = 65_536;

/** Inbound bounds for one socket, as {@link boundInbound} takes them. */
type InboundLimits = { maxWsMessageBytes: number; maxWsQueue: number };

/**
 * The bounds of the mesh control channel's socket, in two phases.
 *
 * - `preAuth`, until the peer's `hello` is accepted: hello-sized frames and the default 16-frame
 *   queue, so an unauthenticated peer can make the process hold about 1 MiB at most — including
 *   while `app.upgrade` waits for a slow boot, before anything reads the queue.
 * - `authed`, after: `maxWsMessageBytes` raised to the channel's frame bound (#120) and `maxWsQueue`
 *   to {@link CONTROL_QUEUE} (#148), each only when larger. The peer holds the mesh secret by then.
 *
 * A user route never goes through this, so it keeps both limits as configured.
 */
export function controlBounds(
  limits: Pick<RequestLimits, 'maxWsMessageBytes' | 'maxWsQueue'> | undefined,
  maxFrameBytes: number | undefined,
): { preAuth: InboundLimits; authed: InboundLimits } {
  return {
    preAuth: { maxWsMessageBytes: HELLO_FRAME_BYTES, maxWsQueue: DEFAULT_MAX_WS_QUEUE },
    authed: {
      maxWsMessageBytes: Math.max(wsMessageBytes(limits), maxFrameBytes ?? 0),
      maxWsQueue: Math.max(limits?.maxWsQueue ?? DEFAULT_MAX_WS_QUEUE, CONTROL_QUEUE),
    },
  };
}

/** Where a socket bounded with a second phase keeps the switch to it; `Symbol.for`, as above. */
const WIDEN_INBOUND: unique symbol = Symbol.for('green-tea.widen-inbound');

/**
 * Switches a socket from {@link boundInbound}'s first bounds to the `widened` ones it was given —
 * for the mesh control channel, once the peer has authenticated. A no-op on any other socket.
 * Frames already queued stay; the new bounds apply to the frames that arrive next.
 */
export function widenInbound(socket: WsSocket): void {
  (socket as { [WIDEN_INBOUND]?: () => void })[WIDEN_INBOUND]?.();
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
 * frames — for the mesh control channel, the `hello` itself. Those early frames go to the first
 * consumer. After that the returned `inbound` fans out like `channel`: each iterator gets every
 * frame from the moment it subscribes, through its own queue, and the bound applies to each queue.
 * Every other capability is the original socket's.
 *
 * `widened`, when given, is a second set of bounds that {@link widenInbound} switches to later: the
 * mesh control channel starts at hello size and widens once its peer authenticates.
 */
export function boundInbound(
  socket: WsSocket,
  limits?: Pick<RequestLimits, 'maxWsMessageBytes' | 'maxWsQueue'>,
  widened?: InboundLimits,
): WsSocket {
  const fanout = new InboundFanout(socket, wsMessageBytes(limits), limits?.maxWsQueue ?? DEFAULT_MAX_WS_QUEUE);

  const tap = (socket.inbound as Partial<TappableChannel<unknown>>)[CHANNEL_TAP];
  if (tap) fanout.tap(tap);
  else void fanout.pump();

  return Object.create(socket, {
    inbound: { value: { [Symbol.asyncIterator]: () => fanout.subscribe() } },
    ...(widened && { [WIDEN_INBOUND]: { value: () => fanout.widen(widened) } }),
  }) as WsSocket;
}

/** The fan-out behind {@link boundInbound}: one bounded queue per consumer. */
class InboundFanout {
  private readonly subs = new Set<InboundSub>();
  /** Holds the frames that arrive before anyone reads; handed to the first consumer. */
  private first: InboundSub | null;
  private ended = false;
  private failure: { err: unknown } | null = null;

  constructor(
    private readonly socket: WsSocket,
    private maxBytes: number,
    private maxQueue: number,
  ) {
    this.first = this.add();
  }

  /** Applies the second phase's bounds; see {@link widenInbound}. */
  widen(limits: InboundLimits): void {
    this.maxBytes = limits.maxWsMessageBytes;
    this.maxQueue = limits.maxWsQueue;
  }

  /**
   * Reads the adapter's channel inside its `push`. Runtimes emit a whole read's worth of frames
   * synchronously — `ws` does — so a bound checked after the event loop yields is checked after an
   * unbounded queue has already taken the burst. Here each frame is bounded before it is queued.
   */
  tap(tap: TappableChannel<unknown>[typeof CHANNEL_TAP]): void {
    const untap = tap({
      push: (msg) => {
        if (this.ended || this.accept(msg)) return;
        untap();
        this.settle();
      },
      end: () => this.settle(),
      fail: (err) => this.settle({ err }),
    });
  }

  // ponytail: only for an inbound that is not a channel (no adapter builds one); bounds late.
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

  subscribe(): AsyncIterator<unknown> {
    const sub = this.first ?? this.add();
    this.first = null;
    return sub;
  }

  private add(): InboundSub {
    const sub = new InboundSub(() => this.subs.delete(sub));
    if (this.ended) sub.settle(this.failure ?? undefined);
    else this.subs.add(sub);
    return sub;
  }

  /** Delivers or queues one frame for every consumer; returns false once it has closed the socket. */
  private accept(msg: unknown): boolean {
    if (exceedsBytes(msg, this.maxBytes)) {
      this.socket.close(1009, 'message too large');
      return false;
    }

    // Capacity first, for every consumer: a frame that overflows one queue reaches none, so a
    // rejected frame cannot run some handlers' side effects and not others'.
    for (const sub of this.subs) {
      if (sub.full(this.maxQueue)) {
        this.socket.close(1013, 'inbound queue full');
        return false;
      }
    }

    for (const sub of this.subs) sub.offer(msg);
    return true;
  }

  /** Ends every consumer once, cleanly or with a failure; whatever is still queued is delivered first. */
  private settle(failure?: { err: unknown }): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = failure ?? null;
    for (const sub of this.subs) sub.settle(failure);
    this.subs.clear();
  }
}

/** One consumer's queue; it is its own async iterator. */
class InboundSub implements AsyncIterator<unknown> {
  private readonly queue: unknown[] = [];
  private waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null = null;
  private ended = false;
  private failure: { err: unknown } | null = null;

  constructor(private readonly onReturn: () => void) {}

  /** True when `max` frames are already waiting and no `next()` is there to take another. */
  full(max: number): boolean {
    return !this.waiter && this.queue.length >= max;
  }

  /** Hands `msg` to a waiting `next()` or queues it; callers check {@link full} first. */
  offer(msg: unknown): void {
    const waiter = this.waiter;

    if (waiter) {
      this.waiter = null;
      waiter.resolve({ value: msg, done: false });
      return;
    }

    this.queue.push(msg);
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
  // the connection for a bound it no longer cares about. Other consumers keep receiving.
  return(): Promise<IteratorResult<unknown>> {
    this.queue.length = 0;
    this.onReturn();
    this.settle();
    return Promise.resolve({ value: undefined, done: true });
  }

  settle(failure?: { err: unknown }): void {
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

/**
 * Drives the outbound async iterator, sending each yielded value until done or the socket closes.
 * Waits for {@link WsSocket.drained} before each pull (#41): a value pulled while the peer is
 * backed up has nowhere to go but the send buffer, so it is not pulled until there is room.
 */
async function pumpOutbound(socket: WsSocket, iterator: AsyncIterator<unknown>): Promise<void> {
  while (true) {
    if (socket.drained) await socket.drained();
    // Closed while waiting: stop before pulling a value nobody can receive. The abort listener in
    // `runWsConnection` has already called the iterator's `return()`. `abort`, not `isOpen`: Deno
    // hands a socket over still CONNECTING, which is not open yet and not closed either.
    if (socket.abort.aborted) break;
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
