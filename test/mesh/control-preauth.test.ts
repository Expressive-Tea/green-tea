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
