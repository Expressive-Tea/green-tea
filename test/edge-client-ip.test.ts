// CARD-23 (#119, D21): on the edge, `cf-connecting-ip` sets `ctx.ip` only under `trustProxy`, for HTTP
// and WebSocket alike, and wins over `x-forwarded-for`. The full WebSocket path through workerd
// (`WebSocketPair`, a 101 response) cannot run under Node, so it is covered in `test/edge/run.ts`;
// here the edge HTTP path runs through `edgeHandler` itself, and the WebSocket side through
// `app.upgrade` with the value recorded the way `edgeHandler` records it.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp, Route, Get, Ws, Module, ctx } from '../src/index';
import { edgeHandler } from '../src/edge';
import { channel } from '../src/channel';
import { setProxyClient } from '../src/http/peer';
import type { WsSocket, WsRequest } from '../src/http/ws-core';

@Route('/ip')
class IpCtl {
  @Get('/whoami') whoami(@ctx() c: any) {
    return { ip: c.ip };
  }

  @Ws('/ws')
  ws(@ctx() c: any) {
    return (async function* () {
      yield String(c.ip);
    })();
  }
}
@Module({ mountpoint: '/', controllers: [IpCtl] })
class IpModule {}

const trusting = createApp({ modules: [IpModule], trustProxy: true });
const untrusting = createApp({ modules: [IpModule] });

const whoami = async (handler: (r: Request) => Response | Promise<Response>, headers: Record<string, string>) =>
  ((await (await handler(new Request('http://x/ip/whoami', { headers }))).json()) as { ip: string }).ip;

describe('edge HTTP: cf-connecting-ip', () => {
  it('T1: under trustProxy it sets ctx.ip', async () => {
    expect(await whoami(edgeHandler(trusting), { 'cf-connecting-ip': '1.2.3.4' })).toBe('1.2.3.4');
  });

  it('T2: under trustProxy it wins over x-forwarded-for', async () => {
    const headers = { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' };
    expect(await whoami(edgeHandler(trusting), headers)).toBe('1.2.3.4');
  });

  it('under trustProxy without the header, x-forwarded-for still applies', async () => {
    expect(await whoami(edgeHandler(trusting), { 'x-forwarded-for': '9.9.9.9' })).toBe('9.9.9.9');
  });

  it('T3: without trustProxy it is ignored and ctx.ip stays empty', async () => {
    expect(await whoami(edgeHandler(untrusting), { 'cf-connecting-ip': '1.2.3.4' })).toBe('');
  });
});

function fakeSocket() {
  const ac = new AbortController();
  const sent: string[] = [];
  const socket: WsSocket = {
    inbound: channel<unknown>(),
    abort: ac.signal,
    isOpen: true,
    send: (d) => sent.push(d),
    close: () => ac.abort(),
    terminate: () => ac.abort(),
  };
  return { socket, sent };
}

/** Upgrades the way `edgeHandler` does: `ip` empty, the header recorded on the `WsRequest`. */
async function edgeWsIp(app: typeof trusting, cfConnectingIp: string): Promise<string> {
  const headers = { 'cf-connecting-ip': cfConnectingIp };
  const req: WsRequest = { url: '/ip/ws', headers, protocol: 'http', ip: '' };
  setProxyClient(req, cfConnectingIp);
  const { socket, sent } = fakeSocket();
  await app.upgrade(req, socket);
  return sent[0];
}

describe('edge WebSocket: cf-connecting-ip', () => {
  it('T4: without trustProxy it is ignored and ctx.ip stays empty', async () => {
    expect(await edgeWsIp(untrusting, '1.2.3.4')).toBe('');
  });

  it('T5: under trustProxy it sets ctx.ip', async () => {
    expect(await edgeWsIp(trusting, '1.2.3.4')).toBe('1.2.3.4');
  });

  it('an adapter-supplied ip with nothing recorded is passed through unchanged', async () => {
    const { socket, sent } = fakeSocket();
    await trusting.upgrade({ url: '/ip/ws', headers: {}, protocol: 'http', ip: '203.0.113.7' }, socket);
    expect(sent).toEqual(['203.0.113.7']);
  });
});

describe('outside the edge adapter the header means nothing', () => {
  it('T6: the Node listener under trustProxy ignores cf-connecting-ip', async () => {
    const server = await createApp({ modules: [IpModule], trustProxy: true }).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/ip/whoami`, { headers: { 'cf-connecting-ip': '1.2.3.4' } });
      const { ip } = (await res.json()) as { ip: string };
      expect(ip).not.toBe('1.2.3.4');
      expect(ip).toMatch(/127\.0\.0\.1|::1/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a bare app.fetch under trustProxy ignores cf-connecting-ip', async () => {
    expect(await whoami((r) => trusting.fetch(r), { 'cf-connecting-ip': '1.2.3.4' })).toBe('');
  });

  it('a bare app.upgrade under trustProxy ignores the header in WsRequest.headers', async () => {
    const { socket, sent } = fakeSocket();
    await trusting.upgrade({ url: '/ip/ws', headers: { 'cf-connecting-ip': '1.2.3.4' }, protocol: 'http', ip: '' }, socket);
    expect(sent).toEqual(['']);
  });
});
