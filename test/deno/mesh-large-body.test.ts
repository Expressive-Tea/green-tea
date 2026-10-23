// #120 (CARD-24, D22) on Deno: an RPC whose body is within `maxBodyBytes` reaches the teapot,
// although the control channel is a WebSocket bounded like every other. Node twin:
// test/mesh/large-body.test.ts, which explains the cases.
//
// Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { createApp, Route, Post, Module, Ws, body, ctx } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

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
  let port = 0;
  const server = await serveDeno(app, {
    port: 0,
    onListen: (addr) => {
      port = addr.port;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { server, port };
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
    await c.server.shutdown();
    await t.server.shutdown();
  };
  return { post, close, tPort: t.port };
}

const json = (bytes: number) => JSON.stringify({ data: 'x'.repeat(bytes - WRAP) });

Deno.test('mesh on Deno: a 1 MB JSON body reaches the teapot (T1)', async () => {
  const { post, close } = await pair();
  try {
    const res = await post(json(1_000_000));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { length: 1_000_000 - WRAP });
    assertEquals((await post(json(1_000_000))).status, 200);
  } finally {
    await close();
  }
});

Deno.test('mesh on Deno: a text body that JSON escaping doubles still reaches the teapot (T1b)', async () => {
  const { post, close } = await pair();
  try {
    const res = await post('"'.repeat(999_000), 'text/plain');
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { length: 999_000 });
    assertEquals((await post('ok', 'text/plain')).status, 200);
  } finally {
    await close();
  }
});

Deno.test('mesh on Deno: a body over maxBodyBytes is 413, and the channel stays open (T2)', async () => {
  const { post, close } = await pair();
  try {
    assertEquals((await post(json(1_000_001))).status, 413);
    assertEquals((await post(json(1_000))).status, 200);
  } finally {
    await close();
  }
});

Deno.test('mesh on Deno: a user ws route on the same teapot still closes 1009 over 1 MiB (T3)', async () => {
  const { close, tPort } = await pair();
  try {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${tPort}/api/big/sock`);
      ws.onopen = () => ws.send('x'.repeat(1_048_577));
      ws.onclose = (e) => resolve(e.code);
    });
    assertEquals(code, 1009);
  } finally {
    await close();
  }
});

Deno.test('mesh on Deno: the control-channel cap follows a raised maxBodyBytes (T4)', async () => {
  const { post, close } = await pair(4_000_000);
  try {
    const res = await post(json(3_900_000));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { length: 3_900_000 - WRAP });
  } finally {
    await close();
  }
});
