export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
  fail(err: unknown): void;
  readonly closed: boolean;
}

export function isAsyncIterable(x: unknown): x is AsyncIterable<unknown> {
  return x != null && typeof (x as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

interface Sub<T> {
  iterator: AsyncIterator<T>;
  push(v: T, cap: number): void;
  end(): void;
  fail(e: unknown): void;
}

function newSub<T>(onReturn: () => void): Sub<T> {
  const queue: T[] = [];
  let pending: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void } | null = null;
  let ended = false;
  let failure: { err: unknown } | null = null;

  return {
    push(v, cap) {
      if (ended) return;
      if (pending) { const p = pending; pending = null; p.resolve({ value: v, done: false }); return; }
      queue.push(v);
      if (queue.length > cap) queue.shift(); // drop-oldest when buffer is full
    },
    end() {
      if (ended) return;
      ended = true;
      if (pending) { const p = pending; pending = null; p.resolve({ value: undefined as never, done: true }); }
    },
    fail(e) {
      if (ended) return;
      ended = true;
      failure = { err: e };
      if (pending) { const p = pending; pending = null; p.reject(e); }
    },
    iterator: {
      next(): Promise<IteratorResult<T>> {
        if (queue.length) return Promise.resolve({ value: queue.shift() as T, done: false });
        if (failure) return Promise.reject(failure.err);
        if (ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => { pending = { resolve, reject }; });
      },
      return(): Promise<IteratorResult<T>> {
        ended = true;
        onReturn();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    },
  };
}

export function channel<T>(opts: { buffer?: number } = {}): Channel<T> {
  const cap = opts.buffer ?? Infinity;
  const subs = new Set<Sub<T>>();
  let done = false;
  let closedFlag = false;

  return {
    get closed() { return closedFlag; },
    push(value) {
      if (done) return;
      for (const s of subs) s.push(value, cap);
    },
    close() {
      if (done) return;
      done = true; closedFlag = true;
      for (const s of subs) s.end();
      subs.clear();
    },
    fail(err) {
      if (done) return;
      done = true; closedFlag = true;
      for (const s of subs) s.fail(err);
      subs.clear();
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const s = newSub<T>(() => subs.delete(s));
      subs.add(s);
      return s.iterator;
    },
  };
}
