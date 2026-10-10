import { describe, it, expect, afterEach } from 'vitest';
import type http from 'http';
import WebSocket from 'ws';
import { createApp, Route, Ws, Module, ctx } from '../src/index';
import type { RequestLimits } from '../src/index';
import { channel } from '../src/channel';
import { boundInbound, type WsSocket } from '../src/http/ws-core';

// #107 / D1: per-connection bounds on inbound WebSocket messages. Node runs the real `ws` server
// behind `listen(0)`; the other runtimes are covered in test/deno, test/bun and test/edge.

const never = new Promise<never>(() => {});

@Route('/rt')
class Rt {
  @Ws('/echo')
  echo(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `echo:${(msg as string).length}`;
    })();
  }

  // Never reads `inbound`: every frame the client sends stays queued.
  @Ws('/stall')
  stall() {
    return (async function* () {
      await never;
      yield '';
    })();
  }

  // Reads exactly one frame, acknowledges it, then stalls.
  @Ws('/one')
  one(@ctx() { inbound }: any) {
    return (async function* () {
      const it = (inbound as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      await it.next();
      yield 'took-one';
      await never;
    })();
  }
}
@Module({ mountpoint: '/', controllers: [Rt] })
class M {}

const servers: http.Server[] = [];
const clients: WebSocket[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.terminate());
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(limits?: RequestLimits): Promise<number> {
  const server = await createApp({ modules: [M], limits }).listen(0);
  servers.push(server);
  return (server.address() as { port: number }).port;
}

async function connect(port: number, path: string) {
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  clients.push(client);
  const messages: string[] = [];
  client.on('message', (d) => messages.push(d.toString()));
  const closed = new Promise<{ code: number; reason: string }>((r) =>
    client.on('close', (code, reason) => r({ code, reason: reason.toString() })),
  );
  await new Promise((r) => client.on('open', r));
  return { client, messages, closed };
}

/** Resolves with the close if it happens within `ms`, else 'open'. */
const closedWithin = (closed: Promise<{ code: number; reason: string }>, ms = 150) =>
  Promise.race([closed, new Promise<'open'>((r) => setTimeout(() => r('open'), ms))]);

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

/** Binary payload of `n` bytes that is valid UTF-8 (ASCII), so its decoded size equals its wire size. */
const binary = (n: number) => Buffer.alloc(n, 0x62);

describe('limits.maxWsMessageBytes on Node (#107)', () => {
  const limits = { maxWsMessageBytes: 1024 };

  it('T1: a text message of exactly the limit is delivered', async () => {
    const { client, messages } = await connect(await serve(limits), '/rt/echo');
    client.send('a'.repeat(1024));
    await until(() => messages.length > 0);
    expect(messages).toEqual(['echo:1024']);
    client.close();
  });

  it('T2: a binary message of exactly the limit is delivered', async () => {
    const { client, messages } = await connect(await serve(limits), '/rt/echo');
    client.send(binary(1024));
    await until(() => messages.length > 0);
    expect(messages).toEqual(['echo:1024']);
    client.close();
  });

  it('T3: one byte of text over the limit closes 1009', async () => {
    const { client, closed } = await connect(await serve(limits), '/rt/echo');
    client.send('a'.repeat(1025));
    expect((await closed).code).toBe(1009);
  });

  it('T4: one byte of binary over the limit closes 1009', async () => {
    const { client, closed } = await connect(await serve(limits), '/rt/echo');
    client.send(binary(1025));
    expect((await closed).code).toBe(1009);
  });

  it('T5: the limit counts UTF-8 bytes, not characters', async () => {
    const { client, closed } = await connect(await serve(limits), '/rt/echo');
    client.send('€'.repeat(342)); // 342 UTF-16 units, 1026 UTF-8 bytes
    expect((await closed).code).toBe(1009);
  });

  it('T6: a fragmented message is measured whole', async () => {
    const { client, closed } = await connect(await serve(limits), '/rt/echo');
    client.send('a'.repeat(400), { fin: false });
    client.send('a'.repeat(400), { fin: false });
    client.send('a'.repeat(400), { fin: true });
    expect((await closed).code).toBe(1009);
  });
});

describe('limits.maxWsQueue on Node (#107)', () => {
  const limits = { maxWsQueue: 4 };

  it('T7: a stalled consumer with the queue exactly full stays open', async () => {
    const { client, closed } = await connect(await serve(limits), '/rt/stall');
    for (let i = 0; i < 4; i++) client.send(`m${i}`);
    expect(await closedWithin(closed)).toBe('open');
    client.close();
  });

  it('T8: one more frame than the queue holds closes 1013, inbound queue full', async () => {
    const { client, closed } = await connect(await serve(limits), '/rt/stall');
    for (let i = 0; i < 5; i++) client.send(`m${i}`);
    expect(await closed).toEqual({ code: 1013, reason: 'inbound queue full' });
  });

  it('T9: the bound counts undelivered frames, so a delivered one frees a slot', async () => {
    const { client, messages, closed } = await connect(await serve(limits), '/rt/one');
    for (let i = 0; i < 4; i++) client.send(`m${i}`);
    await until(() => messages.length > 0);
    expect(messages).toEqual(['took-one']);
    client.send('m4'); // 3 left queued + this one = 4
    expect(await closedWithin(closed)).toBe('open');
    client.close();
  });
});

describe('ws limit defaults on Node (#107)', () => {
  it('T10: 1 MiB is accepted and 1 MiB + 1 closes 1009', async () => {
    const port = await serve();
    const ok = await connect(port, '/rt/echo');
    ok.client.send('a'.repeat(1_048_576));
    await until(() => ok.messages.length > 0);
    expect(ok.messages).toEqual(['echo:1048576']);
    ok.client.close();

    const over = await connect(port, '/rt/echo');
    over.client.send('a'.repeat(1_048_577));
    expect((await over.closed).code).toBe(1009);
  });

  it('T10: 16 queued frames are held and the 17th closes 1013', async () => {
    const port = await serve();
    const held = await connect(port, '/rt/stall');
    for (let i = 0; i < 16; i++) held.client.send(`m${i}`);
    expect(await closedWithin(held.closed)).toBe('open');
    held.client.close();

    const over = await connect(port, '/rt/stall');
    for (let i = 0; i < 17; i++) over.client.send(`m${i}`);
    expect((await over.closed).code).toBe(1013);
  });
});

describe('ws limit validation (#107)', () => {
  it.each([
    ['maxWsQueue', 0],
    ['maxWsQueue', -1],
    ['maxWsQueue', 1.5],
    ['maxWsQueue', '16'],
    ['maxWsQueue', NaN],
    ['maxWsMessageBytes', 0],
    ['maxWsMessageBytes', -1],
    ['maxWsMessageBytes', 1.5],
    ['maxWsMessageBytes', '16'],
    ['maxWsMessageBytes', Infinity],
  ])('T11: limits.%s = %s fails createApp with a TypeError naming the key', (key, value) => {
    expect(() => createApp({ modules: [M], limits: { [key]: value } as RequestLimits })).toThrow(
      new RegExp(`^limits\\.${key} must be a positive integer`),
    );
    expect(() => createApp({ modules: [M], limits: { [key]: value } as RequestLimits })).toThrow(TypeError);
  });

  it('accepts positive integers and absent keys', () => {
    expect(() => createApp({ modules: [M], limits: { maxWsQueue: 1, maxWsMessageBytes: 1 } })).not.toThrow();
    expect(() => createApp({ modules: [M], limits: {} })).not.toThrow();
  });
});

/** A WsSocket over a channel that records closes. */
function fakeSocket() {
  const inbound = channel<unknown>();
  const closes: Array<[number | undefined, string | undefined]> = [];
  const socket: WsSocket = {
    inbound,
    abort: new AbortController().signal,
    isOpen: true,
    send: () => {},
    close: (code, reason) => closes.push([code, reason]),
    terminate: () => {},
  };
  return { socket, inbound, closes };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('boundInbound (#107)', () => {
  it('T15: delivers frames in order to a waiting consumer and to a late one', async () => {
    const { socket, inbound } = fakeSocket();
    const bounded = boundInbound(socket, { maxWsQueue: 4 });
    const it = bounded.inbound[Symbol.asyncIterator]();
    const first = it.next();
    inbound.push('a');
    expect(await first).toEqual({ value: 'a', done: false });
    inbound.push('b');
    inbound.push('c');
    await tick();
    expect(await it.next()).toEqual({ value: 'b', done: false });
    expect(await it.next()).toEqual({ value: 'c', done: false });
  });

  it('T15: subscribes immediately, so frames sent before the consumer arrives are kept', async () => {
    const { socket, inbound } = fakeSocket();
    const bounded = boundInbound(socket);
    await tick();
    inbound.push('early');
    await tick();
    expect(await bounded.inbound[Symbol.asyncIterator]().next()).toEqual({ value: 'early', done: false });
  });

  it('T15: closes 1009 on an oversized frame and never delivers it', async () => {
    const { socket, inbound, closes } = fakeSocket();
    const bounded = boundInbound(socket, { maxWsMessageBytes: 3 });
    await tick();
    inbound.push('€'); // 3 bytes: fits
    inbound.push('€a'); // 4 bytes
    await tick();
    expect(closes).toEqual([[1009, 'message too large']]);
    const it = bounded.inbound[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: '€', done: false });
    expect((await it.next()).done).toBe(true);
  });

  it('T15: closes 1013 on overflow, delivers what was queued, then ends', async () => {
    const { socket, inbound, closes } = fakeSocket();
    const bounded = boundInbound(socket, { maxWsQueue: 2 });
    await tick();
    for (const m of ['a', 'b', 'c']) inbound.push(m);
    await tick();
    expect(closes).toEqual([[1013, 'inbound queue full']]);
    const got: unknown[] = [];
    for await (const m of bounded.inbound) got.push(m);
    expect(got).toEqual(['a', 'b']);
  });

  it('T15: ends when the socket inbound ends', async () => {
    const { socket, inbound } = fakeSocket();
    const bounded = boundInbound(socket);
    const it = bounded.inbound[Symbol.asyncIterator]();
    const pending = it.next();
    inbound.close();
    expect((await pending).done).toBe(true);
    expect((await it.next()).done).toBe(true);
  });

  it('T15: propagates a socket failure to a waiting and a later consumer', async () => {
    const { socket, inbound } = fakeSocket();
    const bounded = boundInbound(socket);
    const it = bounded.inbound[Symbol.asyncIterator]();
    const pending = it.next();
    const boom = new Error('boom');
    inbound.fail(boom);
    await expect(pending).rejects.toBe(boom);
    await expect(it.next()).rejects.toBe(boom);
  });

  it('T15: a consumer that returns stops queueing, so it is never closed for not reading', async () => {
    const { socket, inbound, closes } = fakeSocket();
    const bounded = boundInbound(socket, { maxWsQueue: 1 });
    const it = bounded.inbound[Symbol.asyncIterator]();
    await it.return?.();
    for (const m of ['a', 'b', 'c']) inbound.push(m);
    await tick();
    expect(closes).toEqual([]);
    expect((await it.next()).done).toBe(true);
  });

  it('fans out: two consumers waiting at once both receive the frame', async () => {
    const { socket, inbound } = fakeSocket();
    const bounded = boundInbound(socket);
    const a = bounded.inbound[Symbol.asyncIterator]();
    const b = bounded.inbound[Symbol.asyncIterator]();
    const [nextA, nextB] = [a.next(), b.next()];
    inbound.push('x');
    expect(await nextA).toEqual({ value: 'x', done: false });
    expect(await nextB).toEqual({ value: 'x', done: false });
  });

  it('fans out: a consumer that returns does not end the next one', async () => {
    const { socket, inbound } = fakeSocket();
    const bounded = boundInbound(socket);
    const first = bounded.inbound[Symbol.asyncIterator]();
    const firstNext = first.next();
    inbound.push('a');
    expect(await firstNext).toEqual({ value: 'a', done: false });
    await first.return?.();
    const second = bounded.inbound[Symbol.asyncIterator]();
    const secondNext = second.next();
    inbound.push('b');
    expect(await secondNext).toEqual({ value: 'b', done: false });
  });

  it('fans out: the bound applies to each consumer, so one stalled reader closes 1013', async () => {
    const { socket, inbound, closes } = fakeSocket();
    const bounded = boundInbound(socket, { maxWsQueue: 2 });
    const reader = bounded.inbound[Symbol.asyncIterator]();
    bounded.inbound[Symbol.asyncIterator](); // subscribed, never reads
    for (const m of ['a', 'b', 'c']) {
      const got = reader.next();
      inbound.push(m);
      await got;
    }
    expect(closes).toEqual([[1013, 'inbound queue full']]);
  });

  it('T15: keeps the socket capabilities other than inbound', () => {
    const { socket } = fakeSocket();
    const bounded = boundInbound(socket);
    expect(bounded.isOpen).toBe(true);
    expect(bounded.abort).toBe(socket.abort);
    bounded.close(1000, 'bye');
  });
});
