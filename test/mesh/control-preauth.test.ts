// Before a peer's `hello` is accepted, the mesh control channel takes only hello-sized frames and
// a small queue. The large bounds that carry RPC bodies (#120, #148) apply after authentication
// only, so an unauthenticated peer cannot make the process buffer `queue × frame` bytes — which
// at 4,096 × 7 MB was tens of GB, reachable while `app.upgrade` waits for a slow boot.
import { describe, it, expect } from 'vitest';
import { createApp, Module, Provider, Step } from '../../src/index';
import { channel } from '../../src/channel';
import { MESH_CONTROL_PATH } from '../../src/mesh/teapot';
import { encode, MESH_PROTOCOL_VERSION } from '../../src/mesh/protocol';
import type { WsSocket, WsRequest } from '../../src/http/ws-core';

@Provider({ provides: 'slow' })
class Slow {
  async provide() {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { slow: true };
  }
}
@Step({ provides: 'cfg', needs: [], export: true })
class Cfg {
  run() {
    return { cfg: 1 };
  }
}
@Module({ mountpoint: '/api', providers: [Slow], steps: [Cfg] })
class SlowTeapot {}

function fakeSocket() {
  const inbound = channel<unknown>();
  const ac = new AbortController();
  const sent: string[] = [];
  const closes: number[] = [];
  const socket: WsSocket = {
    inbound,
    abort: ac.signal,
    get isOpen() {
      return !ac.signal.aborted;
    },
    send: (d) => sent.push(d),
    close: (code) => {
      if (ac.signal.aborted) return;
      closes.push(code ?? 1005);
      ac.abort();
      inbound.close();
    },
    terminate: () => ac.abort(),
  };
  return { socket, inbound, sent, closes };
}

const req: WsRequest = { url: MESH_CONTROL_PATH, headers: {}, protocol: 'http', ip: '' };
const teapot = () => createApp({ modules: [SlowTeapot], experimental: true, mesh: { secret: 's3cr3t' } });

describe('mesh control channel before authentication', () => {
  it('closes 1009 on a frame over hello size while the boot is still running', async () => {
    const app = teapot();
    const { socket, inbound, closes } = fakeSocket();
    const run = app.upgrade(req, socket);

    inbound.push('x'.repeat(1_000_000));
    expect(closes).toEqual([1009]); // at once: the boot has not finished, nothing was buffered
    await run;
    await app.close();
  });

  it('closes 1013 when an unauthenticated peer floods frames during the boot', async () => {
    const app = teapot();
    const { socket, inbound, closes } = fakeSocket();
    const run = app.upgrade(req, socket);

    let accepted = 0;
    for (let i = 0; i < 64 && !closes.length; i++, accepted++) inbound.push('x'.repeat(1024));
    expect(closes).toEqual([1013]);
    expect(accepted).toBeLessThanOrEqual(17); // the user default, not the authenticated 4,096
    await run;
    await app.close();
  });

  it('lifts the bounds once the hello is accepted', async () => {
    const app = teapot();
    const { socket, inbound, sent, closes } = fakeSocket();
    const run = app.upgrade(req, socket);

    inbound.push(encode({ type: 'hello', v: MESH_PROTOCOL_VERSION, secret: 's3cr3t' }));
    await new Promise((resolve) => setTimeout(resolve, 400)); // boot, then the handshake
    expect(JSON.parse(sent[0]).type).toBe('manifest');

    // A frame far over hello size is accepted now (undecodable, so ignored), and a burst of 64
    // fits the authenticated queue.
    inbound.push('x'.repeat(1_000_000));
    for (let i = 0; i < 64; i++) inbound.push(encode({ type: 'ping' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closes).toEqual([]);
    expect(sent.filter((s) => s.includes('pong'))).toHaveLength(64);

    socket.close(1000);
    await run;
    await app.close();
  });
});

// The Node adapter's own half: `ws` assembles a frame up to its `maxPayload` before `boundInbound`
// sees it, and the control channel's must fit an authenticated RPC (~7 MB). A raw client shows
// what `ws` does with a frame it has only started to receive.
describe('mesh control channel before authentication, on Node', () => {
  @Module({ mountpoint: '/api', steps: [Cfg] })
  class NodeTeapot {}

  /** Upgrades a raw TCP socket to the control path and resolves once the `101` is in. */
  async function rawControl(port: number) {
    const { connect } = await import('node:net');
    const sock = connect(port, '127.0.0.1');
    let closed = false;
    const received: Buffer[] = [];
    sock.on('close', () => (closed = true));
    sock.on('error', () => {});
    sock.write(
      `GET ${MESH_CONTROL_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    await new Promise<void>((resolve) => sock.once('data', () => resolve()));
    sock.on('data', (chunk: Buffer) => received.push(chunk));
    sock.on('end', () => sock.end());
    return { sock, closed: () => closed, received: () => Buffer.concat(received) };
  }

  /** The start of a masked text frame announcing `length` payload bytes (64-bit length form). */
  const frameHeader = (length: number) => {
    const header = Buffer.alloc(14);
    header[0] = 0x81; // FIN, text
    header[1] = 0x80 | 127; // masked, 64-bit length follows
    header.writeBigUInt64BE(BigInt(length), 2);
    return header; // mask key: the last four bytes, zero
  };

  it('closes 1009 a peer that sends more than a hello before its hello, instead of assembling the frame', async () => {
    const app = createApp({ modules: [NodeTeapot], experimental: true, mesh: { secret: 's3cr3t' } });
    const server = await app.listen(0);
    const { sock, closed, received } = await rawControl((server.address() as { port: number }).port);
    try {
      // 5 MB announced, under the authenticated bound; 200 KiB of it sent, then nothing.
      sock.write(frameHeader(5_000_000));
      sock.write(Buffer.alloc(200 * 1024, 0x78));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(closed()).toBe(true);
      const close = received();
      expect(close[0]).toBe(0x88); // FIN, close
      expect(close.readUInt16BE(2)).toBe(1009);
    } finally {
      sock.destroy();
      await app.close();
    }
  });
});
