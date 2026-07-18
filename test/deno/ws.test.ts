// Real Deno integration test for serveDeno: boots an app under the actual Deno runtime
// and round-trips both HTTP (app.fetch) and WebSocket (Deno.upgradeWebSocket -> app.upgrade).
//
// Run with: npm run test:deno  (or: deno test --allow-net --allow-read --no-check test/deno/)
//
// `--no-check`: the barrel (`src/index.ts`) re-exports types from Node-only modules
// (e.g. `src/http/*`) that reference ambient Node globals like `Buffer`. Those modules
// aren't executed under Deno (this test only exercises `serveDeno`'s fetch/WebSocket
// path), but Deno's checker still type-checks the whole reachable graph and has no
// ambient `Buffer` type without a full `@types/node` setup. Node-side static typing for
// those modules is already covered by `npm run typecheck` (tsc); this test's job is to
// prove Deno *runtime* behavior of the adapter, not re-typecheck Node-only internals.
import 'npm:reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { createApp, Route, Ws, Get, Module, ctx } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

@Route('/rt')
class Rt {
  @Get('/hello')
  hello() {
    return { ok: true };
  }

  @Ws('/echo')
  echo(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `echo:${msg}`;
    })();
  }
}

@Module({ mountpoint: '/', controllers: [Rt] })
class M {}

Deno.test('serveDeno: HTTP + WebSocket round-trip through the graph', async () => {
  const app = createApp({ modules: [M] });

  let port = 0;
  const server = serveDeno(app, {
    port: 0,
    onListen: (addr) => {
      port = addr.port;
    },
  });

  // Let onListen fire before we try to connect.
  await new Promise((resolve) => setTimeout(resolve, 50));

  try {
    const httpRes = await fetch(`http://127.0.0.1:${port}/rt/hello`);
    assertEquals(httpRes.status, 200);
    assertEquals((await httpRes.json()).ok, true);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/echo`);
    try {
      const got = await new Promise<string>((resolve, reject) => {
        ws.onopen = () => ws.send('hi');
        ws.onmessage = (e) => resolve(String(e.data));
        ws.onerror = () => reject(new Error('ws error'));
      });
      assertEquals(got, 'echo:hi');
    } finally {
      ws.close();
      // Give the close frame a moment to complete the handshake so no socket is leaked.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await server.shutdown();
  }
});
