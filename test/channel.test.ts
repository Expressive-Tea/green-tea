import { describe, it, expect } from 'vitest';
import { channel, isAsyncIterable, raceUntil } from '../src/channel';

const collect = async <T>(it: AsyncIterable<T>, n: number): Promise<T[]> => {
  const out: T[] = [];
  for await (const v of it) { out.push(v); if (out.length === n) break; }
  return out;
};

describe('isAsyncIterable', () => {
  it('detects async iterables, rejects sync ones', () => {
    expect(isAsyncIterable(channel())).toBe(true);
    expect(isAsyncIterable((async function* () {})())).toBe(true);
    expect(isAsyncIterable('string')).toBe(false);
    expect(isAsyncIterable([1, 2])).toBe(false);
    expect(isAsyncIterable(Buffer.from('x'))).toBe(false);
    expect(isAsyncIterable(null)).toBe(false);
    expect(isAsyncIterable({})).toBe(false);
  });
});

describe('channel', () => {
  it('fans out the same values to two subscribers', async () => {
    const ch = channel<number>();
    const a = collect(ch, 3);
    const b = collect(ch, 3);
    await Promise.resolve();           // let both subscribe
    ch.push(1); ch.push(2); ch.push(3);
    expect(await a).toEqual([1, 2, 3]);
    expect(await b).toEqual([1, 2, 3]);
  });

  it('close() ends the for-await', async () => {
    const ch = channel<number>();
    const seen: number[] = [];
    const done = (async () => { for await (const v of ch) seen.push(v); })();
    await Promise.resolve();
    ch.push(1); ch.close();
    await done;
    expect(seen).toEqual([1]);
    expect(ch.closed).toBe(true);
  });

  it('fail() throws in the consumer', async () => {
    const ch = channel<number>();
    const boom = new Error('boom');
    const run = (async () => { for await (const _ of ch) { /* */ } })();
    await Promise.resolve();
    ch.fail(boom);
    await expect(run).rejects.toThrow('boom');
  });

  it('bounded buffer drops oldest for a slow subscriber', async () => {
    const ch = channel<number>({ buffer: 2 });
    const it = ch[Symbol.asyncIterator]();
    await Promise.resolve();
    ch.push(1); ch.push(2); ch.push(3);  // 1 dropped, queue = [2,3]
    ch.close();
    expect((await it.next()).value).toBe(2);
    expect((await it.next()).value).toBe(3);
    expect((await it.next()).done).toBe(true);
  });

  it('.return() on one subscriber does not affect the other', async () => {
    const ch = channel<number>();
    const a = ch[Symbol.asyncIterator]();
    const b = ch[Symbol.asyncIterator]();
    await Promise.resolve();
    await a.return!();                 // a unsubscribes
    ch.push(7); ch.close();
    expect((await b.next()).value).toBe(7);
    expect((await a.next()).done).toBe(true);
  });
});

describe('raceUntil (#80)', () => {
  it('settles with the promise while stop is pending', async () => {
    const until = raceUntil(new Promise(() => {}));
    expect(await until(Promise.resolve(1))).toBe(1);
    await expect(until(Promise.reject(new Error('x')))).rejects.toThrow('x');
  });

  it('settles the call in flight, and every later one, with undefined once stop resolves', async () => {
    let stop!: () => void;
    const until = raceUntil(new Promise<void>((r) => (stop = r)));
    const inFlight = until(new Promise(() => {}));
    stop();
    expect(await inFlight).toBeUndefined();
    expect(await until(new Promise(() => {}))).toBeUndefined();
  });

  it('rejects with the reason stop rejects with', async () => {
    let fail!: (e: unknown) => void;
    const until = raceUntil(new Promise((_, r) => (fail = r)));
    const inFlight = until(new Promise(() => {}));
    fail(new Error('reset'));
    await expect(inFlight).rejects.toThrow('reset');
  });
});
