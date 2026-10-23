// #41 (CARD-26, D23): the outbound pump waits while the socket is backed up.
//
// Over a real `ws` server on Node: a route that can produce 10,000 frames of 64 KiB (640 MiB)
// for a client that has stopped reading. Without backpressure the pump pulls all of them into
// the send buffer at once; with it, it stops pulling after about the high-water mark plus what
// the kernel's socket buffers absorb. The Deno and Bun twins live in test/deno and test/bun; the
// exact "mark plus one frame" bound is pinned with a fake socket in ws-core.test.ts.
import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { createHttpServer, type WsRouteDef } from '../src/http';

const FRAMES = 10_000;
const FRAME = 64 * 1024;
/** Frame `i`: its index, zero-padded, then filler up to 64 KiB. */
const frame = (i: number) => String(i).padStart(8, '0') + 'x'.repeat(FRAME - 8);

const url = (server: import('http').Server, path: string) => {
  const a = server.address();
  if (a && typeof a === 'object') return `ws://127.0.0.1:${a.port}${path}`;
  throw new Error('no address');
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ws outbound backpressure (#41)', () => {
  it('stops pulling while the client is not reading, then delivers every frame in order (T1)', async () => {
    let pulled = 0;
    const wsRoutes: WsRouteDef[] = [
      {
        pattern: '/flood',
        open: async () =>
          (async function* () {
            for (let i = 0; i < FRAMES; i++) {
              pulled++;
              yield frame(i);
            }
          })(),
      },
    ];
    const server = createHttpServer([], wsRoutes);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const client = new WebSocket(url(server, '/flood'));
    await new Promise((resolve) => client.once('upgrade', resolve));
    // The client stops reading from TCP: the server's send buffer is all that can grow.
    (client as any)._socket.pause();

    await sleep(300);
    const stalled = pulled;
    await sleep(200);

    // Pulling has stopped, far short of the 10,000 frames on offer: about the 1 MiB mark plus the
    // kernel's socket buffers. Before #41 every frame was pulled at once, 640 MiB in memory.
    expect(pulled).toBe(stalled);
    expect(stalled).toBeLessThan(FRAMES / 10);

    let next = 0;
    let inOrder = true;
    const done = new Promise<void>((resolve) => {
      client.on('message', (data) => {
        if (data.toString('latin1', 0, 8) !== String(next).padStart(8, '0')) inOrder = false;
        if (++next === FRAMES) resolve();
      });
    });
    (client as any)._socket.resume();
    await done;

    expect(inOrder).toBe(true);
    expect(pulled).toBe(FRAMES);
    client.close();
    server.close();
  }, 60_000);

  it('calls the iterator return() when the client goes away while the pump waits (T2)', async () => {
    let pulled = 0;
    let returned = false;
    const wsRoutes: WsRouteDef[] = [
      {
        pattern: '/flood',
        open: async () =>
          (async function* () {
            try {
              for (let i = 0; i < FRAMES; i++) {
                pulled++;
                yield frame(i);
              }
            } finally {
              returned = true;
            }
          })(),
      },
    ];
    const server = createHttpServer([], wsRoutes);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const client = new WebSocket(url(server, '/flood'));
    await new Promise((resolve) => client.once('upgrade', resolve));
    (client as any)._socket.pause();
    await sleep(300);
    expect(pulled).toBeLessThan(FRAMES / 10); // waiting, not finished

    client.terminate();
    await sleep(200);

    expect(returned).toBe(true);
    expect(pulled).toBeLessThan(FRAMES / 10);
    server.close();
  }, 30_000);
});
