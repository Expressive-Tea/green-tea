// #41 (CARD-26, D23) on Bun: the outbound pump waits while the socket is backed up. Bun has no
// `bufferedAmount` property; the adapter reads `getBufferedAmount()` and waits on `drain`.
// Node twin: test/ws-backpressure.test.ts, which explains the cases.
//
// Run with: npm run test:bun
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp, Route, Ws, Module } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';
import { rawWs } from '../helpers/raw-ws.ts';

const FRAMES = 10_000;
const FRAME = 64 * 1024;
const frame = (i: number) => String(i).padStart(8, '0') + 'x'.repeat(FRAME - 8);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const state = { pulled: 0, returned: false };

@Route('/bp')
class Flood {
  @Ws('/flood')
  flood() {
    return (async function* () {
      try {
        for (let i = 0; i < FRAMES; i++) {
          state.pulled++;
          yield frame(i);
        }
      } finally {
        state.returned = true;
      }
    })();
  }
}
@Module({ mountpoint: '/', controllers: [Flood] })
class M {}

async function serve() {
  state.pulled = 0;
  state.returned = false;
  const server = await serveBun(createApp({ modules: [M] }), { port: 0 });
  return { server, port: server.port };
}

test('serveBun: ws outbound stops pulling while the client is not reading, then delivers in order (T1)', async () => {
  const { server, port } = await serve();
  try {
    const client = await rawWs(port, '/bp/flood', FRAME);
    client.pause();
    await sleep(300);
    const stalled = state.pulled;
    await sleep(200);
    expect(state.pulled).toBe(stalled);
    expect(stalled).toBeLessThan(FRAMES / 10);

    expect(await client.readAll(FRAMES)).toEqual({ received: FRAMES, inOrder: true });
    expect(state.pulled).toBe(FRAMES);
    client.destroy();
  } finally {
    server.stop(true);
  }
}, 60_000);

test('serveBun: ws outbound ends the wait and calls return() when the client goes away (T2)', async () => {
  const { server, port } = await serve();
  try {
    const client = await rawWs(port, '/bp/flood', FRAME);
    client.pause();
    await sleep(300);
    expect(state.pulled).toBeLessThan(FRAMES / 10);

    client.destroy();
    await sleep(300);
    expect(state.returned).toBe(true);
    expect(state.pulled).toBeLessThan(FRAMES / 10);
  } finally {
    server.stop(true);
  }
}, 60_000);
