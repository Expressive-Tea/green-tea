import { describe, it, expect } from 'vitest';
import { runWsConnection, matchWsRoute, type WsSocket, type WsRequest } from '../src/http/ws-core';
import { channel } from '../src/channel';
import { HttpError } from '../src/signals';
import { Bus } from '../src/bus';
import type { WsRouteDef } from '../src/http/types';

/** A controllable fake WsSocket that records sends and closes. */
function fakeSocket() {
  const inbound = channel<unknown>();
  const ac = new AbortController();
  const sent: string[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  let open = true;
  const socket: WsSocket = {
    inbound,
    abort: ac.signal,
    get isOpen() {
      return open;
    },
    send: (d) => sent.push(d),
    close: (code, reason) => {
      open = false;
      closes.push({ code, reason });
      ac.abort();
    },
    terminate: () => {
      open = false;
      ac.abort();
    },
  };
  return { socket, inbound, sent, closes, ac };
}

const req: WsRequest = { url: '/ws', headers: {}, protocol: 'http', ip: '127.0.0.1' };

describe('runWsConnection (neutral core)', () => {
  it('sends each yielded outbound value, string or JSON', async () => {
    const def: WsRouteDef = {
      pattern: '/ws',
      open: async () =>
        (async function* () {
          yield 'hi';
          yield { n: 1 };
        })(),
    };
    const { socket, sent } = fakeSocket();
    await runWsConnection(socket, req, { def, params: {} });
    expect(sent).toEqual(['hi', JSON.stringify({ n: 1 })]);
  });

  it('closes with 4000+status when the route throws an HttpError', async () => {
    const def: WsRouteDef = {
      pattern: '/ws',
      open: async () => {
        throw new HttpError(401, 'nope');
      },
    };
    const { socket, closes } = fakeSocket();
    await runWsConnection(socket, req, { def, params: {} });
    expect(closes[0].code).toBe(4401);
    expect(closes[0].reason).toBe('nope');
  });

  it('closes with 1011 on a generic throw', async () => {
    const def: WsRouteDef = {
      pattern: '/ws',
      open: async () => {
        throw new Error('boom');
      },
    };
    const { socket, closes } = fakeSocket();
    await runWsConnection(socket, req, { def, params: {} });
    expect(closes[0].code).toBe(1011);
  });

  it('registers a closer in the shutdown registry and removes it when done', async () => {
    const streams = new Set<() => void>();
    const def: WsRouteDef = {
      pattern: '/ws',
      open: async () =>
        (async function* () {
          yield 'x';
        })(),
    };
    const { socket } = fakeSocket();
    await runWsConnection(socket, req, { def, params: {} }, undefined, streams);
    expect(streams.size).toBe(0); // added then removed
  });

  it('passes inbound + params + request to route.open', async () => {
    let seen: any;
    const def: WsRouteDef = {
      pattern: '/ws/:id',
      open: async (ctx) => {
        seen = ctx;
        return (async function* () {})();
      },
    };
    const { socket } = fakeSocket();
    await runWsConnection(socket, req, { def, params: { id: '7' } });
    expect(seen.params).toEqual({ id: '7' });
    expect(seen.req).toBe(req);
    expect(typeof seen.inbound[Symbol.asyncIterator]).toBe('function');
    expect(seen.abort).toBeInstanceOf(AbortSignal);
  });

  it('matchWsRoute finds a pattern and captures params', () => {
    const routes: WsRouteDef[] = [{ pattern: '/ws/:id', open: async () => (async function* () {})() }];
    expect(matchWsRoute(routes, '/ws/42')?.params).toEqual({ id: '42' });
    expect(matchWsRoute(routes, '/nope')).toBeUndefined();
  });
});

describe('runWsConnection correlation', () => {
  const def: WsRouteDef = {
    pattern: '/ws',
    open: async () =>
      (async function* () {
        yield 'hi';
      })(),
  };

  const opened = async (headers: WsRequest['headers']): Promise<Record<string, unknown>[]> => {
    const bus = new Bus();
    const seen: Record<string, unknown>[] = [];
    for (const name of ['stream:open', 'stream:close'] as const)
      bus.on(name, (e) => seen.push({ ...e }));
    const { socket } = fakeSocket();
    await runWsConnection(socket, { ...req, headers }, { def, params: {} }, bus);
    return seen;
  };

  it('gives the connection one identity, not one per emitter', async () => {
    const seen = await opened({});
    expect(seen).toHaveLength(2);
    expect(seen[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1].requestId).toBe(seen[0].requestId);
  });

  it('adopts a gateway s x-request-id and carries traceparent through', async () => {
    // An upgrade is an HTTP request with headers like any other: a service behind a proxy must not
    // open a second identity for a connection that already has one.
    const seen = await opened({ 'x-request-id': 'gw-1', traceparent: 'tp-1' });
    expect(seen.map((e) => e.requestId)).toEqual(['gw-1', 'gw-1']);
    expect(seen.map((e) => e.traceId)).toEqual(['tp-1', 'tp-1']);
  });

  it('labels the route pattern and names the transport', async () => {
    const [open] = await opened({});
    expect(open.route).toBe('/ws');
    expect(open.transport).toBe('ws');
  });
});

describe('runWsConnection outbound backpressure (#41)', () => {
  /** A fake socket with a send buffer that only empties when the test says so. */
  function bufferedSocket(mark: number) {
    const fake = fakeSocket();
    let buffered = 0;
    let wake: (() => void) | null = null;
    const socket: WsSocket = Object.assign(Object.create(fake.socket), {
      send: (d: string) => {
        fake.sent.push(d);
        buffered += d.length;
      },
      drained: () =>
        buffered <= mark || fake.ac.signal.aborted
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              wake = resolve;
              fake.ac.signal.addEventListener('abort', () => resolve(), { once: true });
            }),
    });
    const flush = () => {
      buffered = 0;
      wake?.();
      wake = null;
    };
    return { ...fake, socket, flush, buffered: () => buffered };
  }

  const flood = (count: number, size: number, onPull: () => void, onReturn = () => {}) => ({
    pattern: '/ws',
    open: async () =>
      (async function* () {
        try {
          for (let i = 0; i < count; i++) {
            onPull();
            yield String(i).padStart(size, '0');
          }
        } finally {
          onReturn();
        }
      })(),
  });

  it('pulls nothing more once the buffer is over the mark: it peaks at the mark plus one frame (T1)', async () => {
    let pulled = 0;
    const { socket, flush, buffered, sent } = bufferedSocket(10);
    const run = runWsConnection(socket, req, { def: flood(100, 4, () => pulled++), params: {} });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pulled).toBe(3); // 4 + 4 + 4 = 12 > 10: waits after the third frame
    expect(buffered()).toBeLessThanOrEqual(10 + 4);

    while (pulled < 100) {
      flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    flush();
    await run;
    expect(sent.map(Number)).toEqual([...Array(100).keys()]);
  });

  it('ends the wait on close and calls the iterator return(), without an unhandled rejection (T2)', async () => {
    let pulled = 0;
    let returned = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    try {
      const { socket, ac } = bufferedSocket(0);
      const run = runWsConnection(socket, req, {
        def: flood(100, 4, () => pulled++, () => (returned = true)),
        params: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(pulled).toBe(1);

      ac.abort(); // the peer went away
      await run;
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(returned).toBe(true);
      expect(pulled).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('never waits below the mark: drained() answers at once and every frame goes out (T3)', async () => {
    let waits = 0;
    const { socket, sent } = fakeSocket();
    const counted: WsSocket = Object.assign(Object.create(socket), {
      drained: () => {
        waits++;
        return Promise.resolve();
      },
    });
    await runWsConnection(counted, req, { def: flood(50, 4, () => {}), params: {} });
    expect(sent).toHaveLength(50);
    expect(waits).toBe(51); // once before each pull, the last one being the pull that ends it
  });
});
