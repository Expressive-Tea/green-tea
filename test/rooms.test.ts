import { describe, it, expect } from 'vitest';
import { Rooms } from '../src/rooms';

describe('Rooms', () => {
  it('returns the same shared channel for a given name', () => {
    const r = new Rooms();
    expect(r.room('general')).toBe(r.room('general'));
    expect(r.room('a')).not.toBe(r.room('b'));
  });
  it('broadcasts a push to all current subscribers of a room', async () => {
    const r = new Rooms();
    const hub = r.room<number>('x');
    const a = hub[Symbol.asyncIterator]();
    const b = hub[Symbol.asyncIterator]();
    await Promise.resolve();
    hub.push(7);
    expect((await a.next()).value).toBe(7);
    expect((await b.next()).value).toBe(7);
  });
  it('isolates distinct rooms', async () => {
    const r = new Rooms();
    const it = r.room<number>('a')[Symbol.asyncIterator]();
    await Promise.resolve();
    r.room<number>('b').push(1);
    r.room<number>('a').push(2);
    expect((await it.next()).value).toBe(2);
  });
});
