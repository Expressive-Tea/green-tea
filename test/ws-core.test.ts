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
