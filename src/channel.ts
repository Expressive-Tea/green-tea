/**
 * A push-driven async stream: producers call `push`/`close`/`fail`, consumers use `for await`.
 * Each `for await` gets its own independent subscription (fan-out).
 */
export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  fail(err: unknown): void;
  readonly closed: boolean;
}

/** Type guard: true when `x` implements the async-iterable protocol. */
export function isAsyncIterable(x: unknown): x is AsyncIterable<unknown> {
  return x != null && typeof (x as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

/**
 * Internal: tells a source its consumer has gone, without waiting for it to finish. An async
 * generator runs `return()` only once its pending `next()` settles, which for an idle source may be
 * never, and a `return()` may also throw or reject. None of that may hold up or break the cleanup
 * that calls this (GitHub #40). Not exported from the package.
 */
export function releaseIterator(iterator: AsyncIterator<unknown> | undefined): void {
  try {
    void Promise.resolve(iterator?.return?.()).catch(() => {});
  } catch {
    /* a return() that throws synchronously */
  }
}

/**
 * Internal: races each promise it is given against one long-lived `stop`, without leaking.
 * `Promise.race([p, stop])` leaves a reaction on `stop` per call, and they are only freed when
 * `stop` settles, so a stream that sends for an hour kept one per event: the soak job measured
 * ~0.4 MB/s of heap on a 1 kHz SSE stream (#80). Here `stop` holds a single reaction, which settles
 * the call in flight. One call at a time, as the stream loops use it. Not exported from the package.
 */
export function raceUntil(stop: Promise<unknown>): <T>(p: Promise<T>) => Promise<T | undefined> {
  // 0 pending, 1 resolved, 2 rejected. The resolvers of the call in flight are kept bare and passed
  // straight to `then`, with no wrapper closure per call: this runs once per stream event.
  let ended = 0;
  let reason: unknown;
  let wake: ((v: undefined) => void) | undefined;
  let fail: ((e: unknown) => void) | undefined;

  stop.then(
    () => {
      ended = 1;
      wake?.(undefined);
    },
    (err: unknown) => {
      ended = 2;
      reason = err;
      fail?.(err);
    },
  );

  return <T>(p: Promise<T>) => {
    if (ended) return ended === 1 ? Promise.resolve(undefined) : Promise.reject(reason);
    return new Promise<T | undefined>((resolve, reject) => {
      wake = resolve; // a stale resolver left here after p settles is harmless: settling twice is a no-op
      fail = reject;
      p.then(resolve, reject);
    });
  };
}

/**
 * Internal: reads a channel synchronously, inside `push`, rather than through an async iterator
 * that only drains once the event loop yields. `boundInbound` needs it to bound a WebSocket burst
 * frame by frame, before anything is queued (#107). Not exported from the package; `Symbol.for`
 * because each tsup entry carries its own copy of this module.
 */
export const CHANNEL_TAP: unique symbol = Symbol.for('green-tea.channel-tap');

/** What {@link CHANNEL_TAP} calls, synchronously, for every push, close and fail. */
export interface ChannelSink<T> {
  push(value: T): void;
  end(): void;
  fail(err: unknown): void;
}

/** A channel that can be tapped; every channel built by {@link channel} is one. */
export interface TappableChannel<T> extends Channel<T> {
  [CHANNEL_TAP](sink: ChannelSink<T>): () => void;
}

/**
 * Internal: the per-subscriber cap when `channel()` is given none (#82). Unbounded before, so a slow SSE
 * client on a busy channel grew server memory without limit. Not exported from the package.
 */
export const DEFAULT_CHANNEL_BUFFER = 1024;

interface Sub<T> {
  iterator: AsyncIterator<T>;
  push(value: T, cap: number): void;
  end(): void;
  fail(err: unknown): void;
}

function newSub<T>(onReturn: () => void): Sub<T> {
  const queue: T[] = [];
  let pending: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null = null;
  let ended = false;
  let failure: { err: unknown } | null = null;

  return {
    push(value, cap) {
      if (ended) return;

      if (pending) {
        const waiter = pending;
        pending = null;
        waiter.resolve({ value, done: false });
        return;
      }

      queue.push(value);
      if (queue.length > cap) queue.shift(); // drop-oldest when buffer is full
    },
    end() {
      if (ended) return;
      ended = true;

      if (pending) {
        const waiter = pending;
        pending = null;
        waiter.resolve({ value: undefined as never, done: true });
      }
    },
    fail(err) {
      if (ended) return;
      ended = true;
      failure = { err };

      if (pending) {
        const waiter = pending;
        pending = null;
        waiter.reject(err);
      }
    },
    iterator: {
      next(): Promise<IteratorResult<T>> {
        if (queue.length) return Promise.resolve({ value: queue.shift() as T, done: false });
        if (failure) return Promise.reject(failure.err);
        if (ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          pending = { resolve, reject };
        });
      },
      return(): Promise<IteratorResult<T>> {
        ended = true;
        onReturn();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    },
  };
}

/**
 * Creates a fan-out {@link Channel}. Values pushed are delivered to every active subscriber.
 * @param opts.buffer Per-subscriber queue cap; drops the oldest value when exceeded (default:
 *   {@link DEFAULT_CHANNEL_BUFFER}). Pass `Infinity` to never drop, at the cost of unbounded memory
 *   for a subscriber that stops reading.
 */
export function channel<T>(opts: { buffer?: number } = {}): Channel<T> {
  const cap = opts.buffer ?? DEFAULT_CHANNEL_BUFFER;
  const subs = new Set<Omit<Sub<T>, 'iterator'>>();
  let done = false;
  let closedFlag = false;

  // Public type stays `Channel<T>` (as in beta.2): the tap is internal plumbing, found by `ws-core`
  // through the symbol rather than through this signature.
  const ch: TappableChannel<T> = {
    get closed() {
      return closedFlag;
    },
    push(value) {
      if (done) return;
      for (const sub of subs) sub.push(value, cap);
    },
    close() {
      if (done) return;
      done = true;
      closedFlag = true;
      for (const sub of subs) sub.end();
      subs.clear();
    },
    fail(err) {
      if (done) return;
      done = true;
      closedFlag = true;
      for (const sub of subs) sub.fail(err);
      subs.clear();
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const sub = newSub<T>(() => subs.delete(sub));
      subs.add(sub);
      return sub.iterator;
    },
    [CHANNEL_TAP](sink) {
      if (done) {
        sink.end();
        return () => {};
      }

      subs.add(sink);
      return () => subs.delete(sink);
    },
  };
  return ch;
}
