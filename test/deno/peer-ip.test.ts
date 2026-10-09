// #116 on the real Deno runtime: `serveDeno` hands the socket's peer address to `ctx.ip`, the way
// Node's `listen()` always has. Without it every client shared `''`, so anything keyed on the
// address — the rate-limit plugin above all — put the whole internet in one bucket.
//
// Run with: npm run test:deno
import 'reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { createApp, Route, Get, Module, ctx } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

@Route('/')
class Ctl {
  @Get('/ip') ip(@ctx() c: { ip: string }) {
    return { ip: c.ip };
  }
}
@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

async function ipVia(
  hostname: string,
  opts: { trustProxy?: boolean; headers?: Record<string, string> } = {},
): Promise<string> {
  const server = await serveDeno(createApp({ modules: [M], trustProxy: opts.trustProxy }), {
    hostname,
    port: 0,
    onListen: () => {},
  });
  const port = (server as unknown as { addr: { port: number } }).addr.port;
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;

  try {
    const res = await fetch(`http://${host}:${port}/ip`, { headers: opts.headers });
    return ((await res.json()) as { ip: string }).ip;
  } finally {
    await server.close({ timeoutMs: 1000 });
  }
}

/** Whether this host can bind the IPv6 loopback at all; CI containers often cannot. */
function ipv6Available(): boolean {
  try {
    Deno.listen({ hostname: '::1', port: 0 }).close();
    return true;
  } catch {
    return false;
  }
}

Deno.test('T1 serveDeno: ctx.ip is the socket peer address', async () => {
  assertEquals(await ipVia('127.0.0.1'), '127.0.0.1');
});

Deno.test({
  name: 'T3 serveDeno: an IPv6 peer is passed through as Deno reports it',
  ignore: !ipv6Available(), // skipped, not failed: the host has no IPv6 loopback to connect over
  fn: async () => {
    assertEquals(await ipVia('::1'), '::1');
  },
});

Deno.test('T4 serveDeno: trustProxy takes the first x-forwarded-for hop', async () => {
  const ip = await ipVia('127.0.0.1', { trustProxy: true, headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
  assertEquals(ip, '203.0.113.7');
});

Deno.test('T5 serveDeno: trustProxy without x-forwarded-for falls back to the peer', async () => {
  assertEquals(await ipVia('127.0.0.1', { trustProxy: true }), '127.0.0.1');
});

Deno.test('T6 serveDeno: without trustProxy a spoofed x-forwarded-for is ignored', async () => {
  assertEquals(await ipVia('127.0.0.1', { headers: { 'x-forwarded-for': '1.2.3.4' } }), '127.0.0.1');
});
