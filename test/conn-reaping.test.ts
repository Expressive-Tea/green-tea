// GHSA-g96c-wq2v-87vc: on Node, slow-header sockets and half-open WebSocket peers held their
// connection slot far longer than any timeout said, so a few hundred filled maxConnections.
import 'reflect-metadata';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApp, Route, Get, Module } from '../src/index';
import { nodeSocket, WS_PING_MS } from '../src/http/ws';

@Route('/')
class Ctl {
  @Get('/x') x() {
    return { ok: true };
  }
}
@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

describe('slow-header sockets', () => {
  it('are closed close to headersTimeout, not up to 30s later', async () => {
    const server = await createApp({ modules: [M], limits: { headersTimeoutMs: 300 } }).listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const started = Date.now();
      const closedAfter = await new Promise<number>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /x HTTP/1.1\r\nHost: x\r\n'));
        socket.on('error', () => {});
        socket.resume(); // read, or the server's FIN after its 408 never surfaces as 'close'
        socket.on('close', () => resolve(Date.now() - started));
        setTimeout(() => reject(new Error('socket still open after 5s')), 5_000).unref();
      });
      expect(closedAfter).toBeLessThan(2_500);
    } finally {
      server.close();
    }
  });
});

describe('Node WebSocket heartbeat', () => {
  afterEach(() => vi.useRealTimers());

  const fakeWs = () =>
    Object.assign(new EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      ping: vi.fn(),
      terminate: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    });

  it('terminates a peer that does not answer a ping by the next one', () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    nodeSocket(ws);
    vi.advanceTimersByTime(WS_PING_MS);
    expect(ws.ping).toHaveBeenCalledOnce();
    expect(ws.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WS_PING_MS);
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it('keeps a peer that answers, and stops pinging once closed', () => {
    vi.useFakeTimers();
    const ws = fakeWs();
    nodeSocket(ws);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(WS_PING_MS);
      ws.emit('pong');
    }
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(ws.ping).toHaveBeenCalledTimes(3);
    ws.emit('close');
    vi.advanceTimersByTime(WS_PING_MS * 3);
    expect(ws.ping).toHaveBeenCalledTimes(3);
  });
});
