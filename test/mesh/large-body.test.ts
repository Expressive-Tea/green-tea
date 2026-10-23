// #120 (CARD-24, D22): an RPC whose body is within `maxBodyBytes` must reach the teapot.
//
// The control channel is a WebSocket, and every WebSocket was bounded by
// `limits.maxWsMessageBytes` (1 MiB by default, #107). A body at the HTTP limit (1,000,000 B by
// default) travels inside an `rpc-req` envelope, re-encoded as JSON:
//   - a JSON body re-encodes to about its own size, so 1 MB fits under 1 MiB (T1);
//   - a text body does not: every `"` or `\` doubles under JSON escaping, so a 999 KB text body
//     became a ~2 MB frame and the teapot hung up the whole channel with 1009 (T1b);
//   - a raised `maxBodyBytes` was capped at 1 MiB on the channel regardless (T4).
// Its queue bound had the same problem (#148): `maxWsQueue` (16) closed it 1013 under a burst of
// RPCs, which Node's `ws` delivers in one go. The Deno and Bun twins live in test/deno and test/bun.
import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { createApp, Route, Post, Module, Ws, body, ctx } from '../../src/index';

const SECRET = 's3cr3t';
const WRAP = '{"data":""}'.length;

@Route('/big')
class BigCtl {
  @Post('/echo', { export: true })
  echo(@body() b: { data: string } | string) {
    return { length: typeof b === 'string' ? b.length : b.data.length };
  }

  @Ws('/sock')
  sock(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `echo:${String(msg).length}`;
    })();
  }

  // Never reads `inbound`: every frame stays queued, so the 17th closes 1013 (#107).
  @Ws('/stall')
  stall() {
    return (async function* () {
      await new Promise<never>(() => {});
      yield '';
    })();
  }
}
@Module({ mountpoint: '/api', controllers: [BigCtl] })
class TeapotModule {}

@Module({ mountpoint: '/api' })
class TeacupModule {}

/** A JSON body of exactly `bytes` bytes: `{"data":"xxx…"}`. */
const json = (bytes: number) => JSON.stringify({ data: 'x'.repeat(bytes - WRAP) });

async function pair(maxBodyBytes?: number) {
  const limits = maxBodyBytes ? { maxBodyBytes } : undefined;
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET }, limits });
  const tServer = await teapot.listen(0);
  const tPort = (tServer.address() as any).port;
  const url = `ws://127.0.0.1:${tPort}/__mesh__/control`;
  const teacup = createApp({ modules: [TeacupModule], experimental: true, mesh: { teapots: [{ url, secret: SECRET }] }, limits });
  const cServer = await teacup.listen(0);
  const cPort = (cServer.address() as any).port;
  const post = (payload: string, type = 'application/json') =>
    fetch(`http://127.0.0.1:${cPort}/api/big/echo`, { method: 'POST', headers: { 'content-type': type }, body: payload });
  const close = async () => {
    await teacup.close();
    await teapot.close();
  };
  return { post, close, tPort, teacup };
}

describe('mesh RPC body near maxBodyBytes (#120)', () => {
  it('a 1 MB JSON body reaches the teapot, and the channel stays open (T1)', async () => {
    const { post, close } = await pair();
    try {
      const res = await post(json(1_000_000));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ length: 1_000_000 - WRAP });
      expect((await post(json(1_000_000))).status).toBe(200);
    } finally {
      await close();
    }
  });

  it('a text body that JSON escaping doubles still reaches the teapot (T1b)', async () => {
    const { post, close } = await pair();
    try {
      const res = await post('"'.repeat(999_000), 'text/plain');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ length: 999_000 });
      expect((await post('ok', 'text/plain')).status).toBe(200);
    } finally {
      await close();
    }
  });

  it('a text body of control characters, escaped 6x, still reaches the teapot (T1c)', async () => {
    const { post, close } = await pair();
    try {
      // `\u0001` re-encodes as the six characters `\u0001`: the worst escaping a body can get.
      const res = await post('\u0001'.repeat(999_000), 'text/plain');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ length: 999_000 });
      expect((await post('ok', 'text/plain')).status).toBe(200);
    } finally {
      await close();
    }
  });

  it('a body over maxBodyBytes is refused 413 by the teacup, and the channel stays open (T2)', async () => {
    const { post, close } = await pair();
    try {
      expect((await post(json(1_000_001))).status).toBe(413);
      expect((await post(json(1_000))).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("a user ws route on the same teapot still closes 1009 over maxWsMessageBytes (T3)", async () => {
    const { close, tPort } = await pair();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${tPort}/api/big/sock`);
      await new Promise((resolve) => ws.once('open', resolve));
      const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      ws.send('x'.repeat(1_048_577));
      expect(await closed).toBe(1009);
    } finally {
      await close();
    }
  });

  it('the control-channel cap follows a raised maxBodyBytes (T4)', async () => {
    const { post, close } = await pair(4_000_000);
    try {
      const res = await post(json(3_900_000));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ length: 3_900_000 - WRAP });
    } finally {
      await close();
    }
  });
  it('64 concurrent RPCs on one link all succeed: the control channel has its own queue bound (#148)', async () => {
    const { post, close, teacup } = await pair();
    try {
      // In one tick, through `app.fetch`: all 64 rpc-req frames leave together and land in one read,
    // which is the burst that tripped the 16-frame queue. Over HTTP sockets they trickle in.
    const rpc = () =>
      teacup.fetch(
        new Request('http://x/api/big/echo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: json(100),
        }),
      );
    const res = await Promise.all(Array.from({ length: 64 }, rpc));
      expect(res.map((r) => r.status)).toEqual(Array(64).fill(200));
      expect((await post(json(1_000))).status).toBe(200);
    } finally {
      await close();
    }
  });

  it('a user ws route on the same teapot still closes 1013 at maxWsQueue (#148)', async () => {
    const { close, tPort } = await pair();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${tPort}/api/big/stall`);
      await new Promise((resolve) => ws.once('open', resolve));
      const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      for (let i = 0; i < 17; i++) ws.send(String(i));
      expect(await closed).toBe(1013);
    } finally {
      await close();
    }
  });
  it('an unauthenticated peer sending a frame over hello size is closed 1009', async () => {
    const { close, tPort } = await pair();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${tPort}/__mesh__/control`);
      await new Promise((resolve) => ws.once('open', resolve));
      const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
      ws.send('x'.repeat(1_000_000)); // within the authenticated bound, far over a hello
      expect(await closed).toBe(1009);
    } finally {
      await close();
    }
  });
});
