// #71: Bun.serve cuts a request idle for `idleTimeout` seconds (default 10), shorter than the SSE
// keep-alive ping (15s), so a quiet stream was dropped. `idleTimeout: 2` stands in for the default so
// the test does not wait 10s. Bun checks idleness coarsely (a 2.5s gap survived `idleTimeout: 1`),
// so the stream stays quiet for 6s: without the fix it is cut at about 4s.
//
// Run with: npm run test:bun  (or: bun test test/bun/)
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp, Route, Module, Sse } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

@Route('/')
class Ctl {
  @Sse('/quiet') quiet() {
    return (async function* () {
      yield { t: 1 };
      await Bun.sleep(6000);
      yield { t: 2 };
    })();
  }
}
@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

test('serveBun keeps a quiet SSE stream open past Bun idleTimeout (#71)', async () => {
  const server = await serveBun(createApp({ modules: [M] }), { port: 0, idleTimeout: 2 } as never);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/quiet`, { headers: { accept: 'text/event-stream' } });
    const text = await res.text();
    expect(text).toContain('data: {"t":1}');
    expect(text).toContain('data: {"t":2}');
  } finally {
    await server.close({ timeoutMs: 500 });
  }
}, 10_000);
