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
export function channel<T>(opts: { buffer?: number } = {}): Channel<T> {
  const cap = opts.buffer ?? Infinity;
  const subs = new Set<Sub<T>>();
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
  };
}
