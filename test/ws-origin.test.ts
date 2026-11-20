// GHSA-p697-fpqx-pgf3: a WebSocket upgrade from another site is refused with 403 (cross-site
// WebSocket hijacking). The Deno, Bun and edge suites repeat these cases on their adapters.
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApp, Route, Ws, Module, ctx, type CorsOptions } from '../src/index';
import { wsOriginAllowed } from '../src/security';

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

/** Sends a raw upgrade request and resolves with the response's status code. */
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

async function withServer(cors: CorsOptions | undefined, run: (port: number) => Promise<void>) {
  const server = await createApp({ modules: [M], cors }).listen(0);
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    server.close();
  }
}

describe('WebSocket Origin check (Node)', () => {
  it('accepts no Origin and a same-host Origin', () =>
    withServer(undefined, async (port) => {
      expect(await upgradeStatus(port)).toBe(101);
      expect(await upgradeStatus(port, `http://127.0.0.1:${port}`)).toBe(101);
    }));

  it('refuses another site, and null, with 403', () =>
    withServer(undefined, async (port) => {
      expect(await upgradeStatus(port, 'https://evil.example')).toBe(403);
      expect(await upgradeStatus(port, 'null')).toBe(403);
    }));

  it('accepts an origin cors.origins allows, and still refuses the rest', () =>
    withServer({ origins: ['https://good.example'] }, async (port) => {
      expect(await upgradeStatus(port, 'https://good.example')).toBe(101);
      expect(await upgradeStatus(port, 'https://evil.example')).toBe(403);
    }));
});

describe('wsOriginAllowed', () => {
  it('compares hosts case-insensitively and ignores a default port', () => {
    expect(wsOriginAllowed('https://App.example', 'app.EXAMPLE')).toBe(true);
    expect(wsOriginAllowed('https://app.example:443', 'app.example')).toBe(true);
    expect(wsOriginAllowed('http://app.example:8080', 'app.example')).toBe(false);
  });

  it('denies when a cors predicate throws', () => {
    expect(wsOriginAllowed('https://x.example', 'app.example', { origins: () => { throw new Error('x'); } })).toBe(false);
  });
});
