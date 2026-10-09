import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import net from 'net';
import type http from 'http';
import WebSocket from 'ws';
import { createApp, Route, Get, Ws, Module, ctx } from '../src/index';

// Regression for #104: these drive the real Node `'upgrade'` listener through a `listen(0)` server,
// not `app.upgrade`. The requests are written by hand over a raw socket because a WebSocket client
// refuses or re-encodes the malformed URLs this is about.

@Route('/rt')
class Rt {
  @Ws('/echo')
  echo(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `echo:${msg}`;
    })();
  }

  // A param route is what makes the bad escape fatal: only param segments are decoded on match.
  @Ws('/room/:name')
  room(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `room:${msg}`;
    })();
  }
}
@Route('/health')
class Health {
  @Get('/')
  ok() {
    return { ok: true };
  }
}
@Module({ mountpoint: '/', controllers: [Rt, Health] })
class M {}

/** Writes a raw upgrade request for `path` and resolves with everything the server sent before closing. */
function rawUpgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      ),
    );
    socket.on('data', (chunk) => (data += chunk.toString()));
    socket.on('close', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('Node upgrade listener rejects malformed upgrades (#104)', () => {
  let server: http.Server;
  let port: number;
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => uncaught.push(err);

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    const app = createApp({ modules: [M] });
    server = await app.listen(0);
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
    await new Promise((r) => server.close(r));
  });

  afterEach(async () => {
    // T6: a normal request on a new connection succeeds after every rejected upgrade.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(uncaught).toEqual([]);
  });

  it('T1: malformed percent-encoding gets a 400 and the socket closes', async () => {
    expect(await rawUpgrade(port, '/rt/%E0%A4%A')).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('T1: malformed percent-encoding in a param segment gets a 400 instead of crashing', async () => {
    expect(await rawUpgrade(port, '/rt/room/%E0%A4%A')).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('T2: invalid hex in a percent escape gets a 400', async () => {
    expect(await rawUpgrade(port, '/rt/room/%ZZ')).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('T3: a repeated slash gets a 400 instead of matching /rt/echo', async () => {
    expect(await rawUpgrade(port, '//rt//echo')).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('T4: a long path below the header limit takes the normal miss path (404)', async () => {
    expect(await rawUpgrade(port, `/rt/${'a'.repeat(8 * 1024)}`)).toMatch(/^HTTP\/1\.1 404 /);
  });

  it('T5: an unknown ws route gets a written 404, then close', async () => {
    expect(await rawUpgrade(port, '/nope')).toMatch(/^HTTP\/1\.1 404 /);
  });

  it('T7: a valid upgrade still echoes', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/rt/echo`);
    await new Promise((r) => client.on('open', r));
    const got = new Promise<string>((r) => client.on('message', (d) => r(d.toString())));
    client.send('hi');
    expect(await got).toBe('echo:hi');
    client.close();
  });
});
