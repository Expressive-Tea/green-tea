// #41 (CARD-26, D23) on Deno: the outbound pump waits while the socket is backed up. Deno's
// WebSocket fires no drain event, so the adapter polls `bufferedAmount` while over the mark.
// Node twin: test/ws-backpressure.test.ts, which explains the cases.
//
// Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assert, assertEquals } from 'jsr:@std/assert';
import { createApp, Route, Ws, Module } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';
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
@Route('/early')
class Early {
  // Yields before Deno's socket has left CONNECTING. The pump used to pull 'hi', find the socket
  // not open, and give up: the client got no frame and a close without a code (1005).
  @Ws('/hi')
  hi() {
    return (async function* () {
      yield 'hi';
      await new Promise<never>(() => {});
    })();
  }
}
@Module({ mountpoint: '/', controllers: [Flood, Early] })
class M {}

async function serve() {
  state.pulled = 0;
  state.returned = false;
  let port = 0;
  const server = await serveDeno(createApp({ modules: [M] }), {
    port: 0,
    onListen: (addr) => {
      port = addr.port;
    },
  });
  await sleep(50);
  return { server, port };
}

Deno.test('serveDeno: ws outbound stops pulling while the client is not reading, then delivers in order (T1)', async () => {
  const { server, port } = await serve();
  try {
    const client = await rawWs(port, '/bp/flood', FRAME);
    client.pause();
    await sleep(300);
    const stalled = state.pulled;
    await sleep(200);
    assertEquals(state.pulled, stalled);
    assert(stalled < FRAMES / 10, `pulled ${stalled} of ${FRAMES} with nobody reading`);

    assertEquals(await client.readAll(FRAMES), { received: FRAMES, inOrder: true });
    assertEquals(state.pulled, FRAMES);
    client.destroy();
  } finally {
    await server.shutdown();
  }
});

Deno.test('serveDeno: ws outbound ends the wait and calls return() when the client goes away (T2)', async () => {
  const { server, port } = await serve();
  try {
    const client = await rawWs(port, '/bp/flood', FRAME);
    client.pause();
    await sleep(300);
    assert(state.pulled < FRAMES / 10);

    client.destroy();
    await sleep(300);
    assertEquals(state.returned, true);
    assert(state.pulled < FRAMES / 10);
  } finally {
    await server.shutdown();
  }
});

Deno.test('serveDeno: a ws route that yields at once still delivers its first frame', async () => {
  const { server, port } = await serve();
  try {
    const first = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/early/hi`);
      ws.onmessage = (e) => {
        resolve(String(e.data));
        ws.close();
      };
      ws.onclose = (e) => reject(new Error(`closed ${e.code} before any frame`));
    });
    assertEquals(first, 'hi');
  } finally {
    await server.shutdown();
  }
});
