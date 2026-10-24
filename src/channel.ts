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
 * @param opts.buffer Per-subscriber queue cap; drops oldest when exceeded (default: unbounded).
 */
export function channel<T>(opts: { buffer?: number } = {}): TappableChannel<T> {
  const cap = opts.buffer ?? Infinity;
  const subs = new Set<Omit<Sub<T>, 'iterator'>>();
  let done = false;
  let closedFlag = false;

  return {
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
}
