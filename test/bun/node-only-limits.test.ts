// #76 on serveBun: Node-only limits are reported, not silently ignored.
// Run with: npm run test:bun
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp, Module } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

@Module({ mountpoint: '/' })
class M {}

test('serveBun warns that it ignores Node-only limits', async () => {
  const warned: string[] = [];
  const logger = { debug() {}, info() {}, error() {}, warn: (m: string) => warned.push(m) };
  const server = await serveBun(createApp({ modules: [M], logger, limits: { headersTimeoutMs: 5 } }), { port: 0 });
  try {
    expect(warned.some((m) => m.startsWith('serveBun does not apply limits.headersTimeoutMs'))).toBe(true);
  } finally {
    await server.close({ timeoutMs: 500 });
  }
});
