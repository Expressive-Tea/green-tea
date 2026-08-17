// Real Bun integration test for the bounded close() serveBun returns. app.close() cannot do this
// job on Bun — it returns at its `if (!server)` guard, because a Bun app is served through
// app.fetch and never through listen() — so the deadline lives on the transport that owns the
// handle. See issue #15.
//
// Run with: npm run test:bun  (or: bun test test/bun/)
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp, Route, Get, Module } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

@Route('/')
class Ctl {
  @Get('/hang')
  hang() {
    return new Promise(() => {}); // never resolves — a stuck handler
  }
  @Get('/slow')
  async slow() {
    await Bun.sleep(200); // finite, so draining has something real to wait out
    return { ok: true };
  }
}
@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

test('serveBun close({ timeoutMs }) gives up on a stuck handler and resolves', async () => {
  const server = serveBun(createApp({ modules: [M] }), { port: 0 });

  fetch(`http://127.0.0.1:${server.port}/hang`).catch(() => {});
  await Bun.sleep(50); // let the request actually reach the handler

  const start = Date.now();
  await server.close({ timeoutMs: 300 });
  const elapsed = Date.now() - start;

  // The assertion that matters is the upper bound: without the deadline this never returns.
  expect(elapsed).toBeLessThan(2000);
  expect(elapsed).toBeGreaterThanOrEqual(250);
});

test('serveBun close() drains an in-flight request rather than cutting it', async () => {
  const server = serveBun(createApp({ modules: [M] }), { port: 0 });

  const inFlight = fetch(`http://127.0.0.1:${server.port}/slow`).then((r) => r.json());
  await Bun.sleep(50); // the request must be *in* the handler before we close, or it never got in

  await server.close({ timeoutMs: 5000 });

  expect(await inFlight).toEqual({ ok: true });
});

// D7 of the teardown design: proving the Node path works proves nothing here, because app.close()
// returns at its no-server guard on Bun. The teardown has to run from the close() Bun actually uses.
test('serveBun close() runs registered teardown', async () => {
  const closed: string[] = [];
  const app = createApp({
    modules: [M],
    hooks: [{ onShutdown: () => void closed.push('hook') }],
    plugins: [(api) => api.onShutdown(async () => {
      await Bun.sleep(10);
      closed.push('plugin');
    })],
  });
  const server = serveBun(app, { port: 0 });

  await server.close({ timeoutMs: 2000 });

  // Reverse registration order: the plugin registered after the hook, so it tears down first.
  expect(closed).toEqual(['plugin', 'hook']);
});
