// #120 (CARD-24, D22): an RPC whose body is within `maxBodyBytes` must reach the teapot.
//
// The control channel is a WebSocket, and every WebSocket was bounded by
// `limits.maxWsMessageBytes` (1 MiB by default, #107). A body at the HTTP limit (1,000,000 B by
// default) travels inside an `rpc-req` envelope, re-encoded as JSON:
//   - a JSON body re-encodes to about its own size, so 1 MB fits under 1 MiB (T1);
//   - a text body does not: every `"` or `\` doubles under JSON escaping, so a 999 KB text body
//     became a ~2 MB frame and the teapot hung up the whole channel with 1009 (T1b);
//   - a raised `maxBodyBytes` was capped at 1 MiB on the channel regardless (T4).
// The Deno and Bun twins live in test/deno and test/bun.
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
  return { post, close, tPort };
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
});
