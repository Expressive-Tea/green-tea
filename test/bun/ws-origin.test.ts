// GHSA-p697-fpqx-pgf3 on serveBun: a cross-site WebSocket upgrade is refused with 403 before Bun
// upgrades it. Same cases as test/ws-origin.test.ts (Node).
//
// Run with: npm run test:bun  (or: bun test test/bun/)
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import net from 'node:net';
import { createApp, Route, Ws, Module, ctx } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

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

function upgradeStatus(port: number, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /echo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n' +
          (origin === undefined ? '' : `Origin: ${origin}\r\n`) +
          '\r\n',
      );
    });
    socket.once('data', (chunk) => {
      resolve(Number(chunk.toString('latin1').split(' ')[1]));
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

test('serveBun refuses a cross-site WebSocket upgrade', async () => {
  const server = await serveBun(createApp({ modules: [M], cors: { origins: ['https://good.example'] } }), { port: 0 });
  try {
    expect(await upgradeStatus(server.port)).toBe(101);
    expect(await upgradeStatus(server.port, `http://127.0.0.1:${server.port}`)).toBe(101);
    expect(await upgradeStatus(server.port, 'https://good.example')).toBe(101);
    expect(await upgradeStatus(server.port, 'https://evil.example')).toBe(403);
    expect(await upgradeStatus(server.port, 'null')).toBe(403);
  } finally {
    await server.close({ timeoutMs: 500 });
  }
});
