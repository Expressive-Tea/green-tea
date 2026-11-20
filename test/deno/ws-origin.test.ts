// GHSA-p697-fpqx-pgf3 on serveDeno: a cross-site WebSocket upgrade is refused with 403 before Deno
// upgrades it. Same cases as test/ws-origin.test.ts (Node).
//
// Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { createApp, Route, Ws, Module, ctx } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

@Route('/')
class Ctl {
  @Ws('/echo') echo(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield msg;
    })();
  }
}
@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

async function upgradeStatus(port: number, origin?: string): Promise<number> {
  const conn = await Deno.connect({ hostname: '127.0.0.1', port });
  try {
    await conn.write(
      new TextEncoder().encode(
        `GET /echo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
          (origin === undefined ? '' : `Origin: ${origin}\r\n`) +
          '\r\n',
      ),
    );
    const buf = new Uint8Array(256);
    const n = (await conn.read(buf)) ?? 0;
    return Number(new TextDecoder().decode(buf.subarray(0, n)).split(' ')[1]);
  } finally {
    conn.close();
  }
}

Deno.test({
  name: 'serveDeno refuses a cross-site WebSocket upgrade',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const server = await serveDeno(createApp({ modules: [M], cors: { origins: ['https://good.example'] } }), {
      port: 0,
      onListen: () => {},
    });
    const port = (server.addr as Deno.NetAddr).port;
    try {
      assertEquals(await upgradeStatus(port), 101);
      assertEquals(await upgradeStatus(port, `http://127.0.0.1:${port}`), 101);
      assertEquals(await upgradeStatus(port, 'https://good.example'), 101);
      assertEquals(await upgradeStatus(port, 'https://evil.example'), 403);
      assertEquals(await upgradeStatus(port, 'null'), 403);
    } finally {
      await server.close({ timeoutMs: 500 });
    }
  },
});
