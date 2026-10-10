// #116 on the real Bun runtime: `serveBun` hands the socket's peer address to `ctx.ip`, the way
// Node's `listen()` always has. Without it every client shared `''`, so anything keyed on the
// address — the rate-limit plugin above all — put the whole internet in one bucket.
//
// Run with: npm run test:bun  (or: bun test test/bun/)
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createServer } from 'node:net';
import { createApp, Route, Get, Module, ctx } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

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
  const server = await serveBun(createApp({ modules: [M], trustProxy: opts.trustProxy }), { hostname, port: 0 });
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;

  try {
    const res = await fetch(`http://${host}:${server.port}/ip`, { headers: opts.headers });
    return ((await res.json()) as { ip: string }).ip;
  } finally {
    await server.close({ timeoutMs: 1000 });
  }
}

/** Whether this host can bind the IPv6 loopback at all; CI containers often cannot. */
const ipv6Available = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '::1', () => probe.close(() => resolve(true)));
});

test('T2 serveBun: ctx.ip is the socket peer address', async () => {
  expect(await ipVia('127.0.0.1')).toBe('127.0.0.1');
});

// Skipped, not failed: the host has no IPv6 loopback to connect over.
test.skipIf(!ipv6Available)('T3 serveBun: an IPv6 peer is passed through as Bun reports it', async () => {
  expect(await ipVia('::1')).toBe('::1');
});

test('T4 serveBun: trustProxy takes the first x-forwarded-for hop', async () => {
  const ip = await ipVia('127.0.0.1', { trustProxy: true, headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
  expect(ip).toBe('203.0.113.7');
});

test('T5 serveBun: trustProxy without x-forwarded-for falls back to the peer', async () => {
  expect(await ipVia('127.0.0.1', { trustProxy: true })).toBe('127.0.0.1');
});

test('T6 serveBun: without trustProxy a spoofed x-forwarded-for is ignored', async () => {
  expect(await ipVia('127.0.0.1', { headers: { 'x-forwarded-for': '1.2.3.4' } })).toBe('127.0.0.1');
});
