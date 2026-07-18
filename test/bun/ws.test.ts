// Real Bun integration test for serveBun: boots an app under the actual Bun runtime
// and round-trips both HTTP (app.fetch) and WebSocket (Bun's server-level websocket
// handler -> app.upgrade).
//
// Run with: npm run test:bun  (or: bun test test/bun/)
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp, Route, Get, Ws, ctx, Module } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

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

test('serveBun: HTTP + WebSocket round-trip', async () => {
  const app = createApp({ modules: [M] });
  const server = serveBun(app, { port: 0 });
  const port = server.port;
  try {
    const httpRes = await fetch(`http://127.0.0.1:${port}/rt/hello`);
    expect(httpRes.status).toBe(200);
    expect((await httpRes.json()).ok).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/echo`);
    const got = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send('hi');
      ws.onmessage = (e) => {
        resolve(String(e.data));
        ws.close();
      };
      ws.onerror = () => reject(new Error('ws error'));
    });
    expect(got).toBe('echo:hi');
  } finally {
    server.stop(true);
  }
});
