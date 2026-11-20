// #76 on serveDeno: Node-only limits are reported, not silently ignored.
// Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assert } from 'jsr:@std/assert';
import { createApp, Module } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

@Module({ mountpoint: '/' })
class M {}

Deno.test({
  name: 'serveDeno warns that it ignores Node-only limits',
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const warned: string[] = [];
    const logger = { debug() {}, info() {}, error() {}, warn: (m: string) => warned.push(m) };
    const server = await serveDeno(createApp({ modules: [M], logger, limits: { maxConnections: 5 } }), {
      port: 0,
      onListen: () => {},
    });
    try {
      assert(warned.some((m) => m.startsWith('serveDeno does not apply limits.maxConnections')));
    } finally {
      await server.close({ timeoutMs: 500 });
    }
  },
});
