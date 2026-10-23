// #120 (CARD-24, D22) on Bun: an RPC whose body is within `maxBodyBytes` reaches the teapot,
// although the control channel is a WebSocket bounded like every other. Node twin:
// test/mesh/large-body.test.ts, which explains the cases.
//
// Run with: npm run test:bun
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp, Route, Post, Module, Ws, body, ctx } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

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

async function serve(app: ReturnType<typeof createApp>) {
  const server = await serveBun(app, { port: 0 });
  return { server, port: server.port };
}

async function pair(maxBodyBytes?: number) {
  const limits = maxBodyBytes ? { maxBodyBytes } : undefined;
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET }, limits });
  const t = await serve(teapot);
  const url = `ws://127.0.0.1:${t.port}/__mesh__/control`;
  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    mesh: { teapots: [{ url, secret: SECRET }] },
    limits,
  });
  const c = await serve(teacup);
  const post = (payload: string, type = 'application/json') =>
    fetch(`http://127.0.0.1:${c.port}/api/big/echo`, {
      method: 'POST',
      headers: { 'content-type': type },
      body: payload,
    });
  const close = async () => {
    await teacup.close();
    await teapot.close();
    c.server.stop(true);
    t.server.stop(true);
  };
  return { post, close, tPort: t.port, teacup };
}

const json = (bytes: number) => JSON.stringify({ data: 'x'.repeat(bytes - WRAP) });

test('mesh on Bun: a 1 MB JSON body reaches the teapot (T1)', async () => {
  const { post, close } = await pair();
  try {
    const res = await post(json(1_000_000));
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ length: 1_000_000 - WRAP });
    expect((await post(json(1_000_000))).status).toEqual(200);
  } finally {
    await close();
  }
});

test('mesh on Bun: a text body that JSON escaping doubles still reaches the teapot (T1b)', async () => {
  const { post, close } = await pair();
  try {
    const res = await post('"'.repeat(999_000), 'text/plain');
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ length: 999_000 });
    expect((await post('ok', 'text/plain')).status).toEqual(200);
  } finally {
    await close();
  }
});

test('mesh on Bun: a body over maxBodyBytes is 413, and the channel stays open (T2)', async () => {
  const { post, close, teacup } = await pair();
  try {
    // Through `app.fetch`, not the socket: a client still writing a 1 MB body when Bun's 413 lands
    // can stall or reset (see body-limits.test.ts). That race is the transport's, not the mesh's.
    const over = new Request('http://x/api/big/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json(1_000_001),
    });
    expect((await teacup.fetch(over)).status).toEqual(413);
    expect((await post(json(1_000))).status).toEqual(200);
  } finally {
    await close();
  }
});


// A teapot raises Bun's native `maxPayloadLength` to the control channel's bound, so a user route's
// oversized frame is refused by `app.upgrade` instead, with a real 1009 close frame rather than the
// 1006 drop the native bound gives (see ws.test.ts).
test('mesh on Bun: a user ws route on the same teapot still closes 1009 over 1 MiB (T3)', async () => {
  const { close, tPort } = await pair();
  try {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${tPort}/api/big/sock`);
      ws.onopen = () => ws.send('x'.repeat(1_048_577));
      ws.onclose = (e) => resolve(e.code);
    });
    expect(code).toEqual(1009);
  } finally {
    await close();
  }
});

test('mesh on Bun: the control-channel cap follows a raised maxBodyBytes (T4)', async () => {
  const { post, close } = await pair(4_000_000);
  try {
    const res = await post(json(3_900_000));
    expect(res.status).toEqual(200);
    expect(await res.json()).toEqual({ length: 3_900_000 - WRAP });
  } finally {
    await close();
  }
});
