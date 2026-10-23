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

  // Never reads `inbound`, so every frame the client sends stays queued (#107).
  @Ws('/stall')
  stall() {
    return (async function* () {
      await new Promise<never>(() => {});
      yield '';
    })();
  }

  @Ws('/room/:name')
  room(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `room:${msg}`;
    })();
  }
}
@Module({ mountpoint: '/', controllers: [Rt] })
class M {}

test('serveBun: HTTP + WebSocket round-trip', async () => {
  const app = createApp({ modules: [M] });
  const server = await serveBun(app, { port: 0 });
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

// #104: a malformed escape in a param segment used to reject out of the matcher and close 1011.
test('serveBun: a malformed upgrade path closes 1008 and the server keeps serving', async () => {
  const app = createApp({ modules: [M] });
  const server = await serveBun(app, { port: 0 });
  const port = server.port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/room/%E0%A4%A`);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
    });
    expect(closed).toEqual({ code: 1008, reason: 'invalid request path' });

    const httpRes = await fetch(`http://127.0.0.1:${port}/rt/hello`);
    expect(httpRes.status).toBe(200);
  } finally {
    server.stop(true);
  }
});

/** Opens `path`, sends `frames` once open, and resolves with every reply and the close. */
function exchange(port: number, path: string, frames: string[], until = 2000) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const replies: string[] = [];
  return new Promise<{ replies: string[]; close?: { code: number; reason: string } }>((resolve) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve({ replies });
    }, until);
    ws.onopen = () => frames.forEach((f) => ws.send(f));
    ws.onmessage = (e) => replies.push(String(e.data));
    ws.onclose = (e) => {
      clearTimeout(timer);
      resolve({ replies, close: { code: e.code, reason: e.reason } });
    };
  });
}

// #107: Bun refuses an oversized frame natively (`maxPayloadLength`), before buffering it. Up to
// Bun 1.3 its uWebSockets core dropped the TCP connection without a close frame, so the peer saw
// `1006`; from Bun 1.4 it sends a real `1009`, like Node, Deno and the edge. Asserted per version
// rather than papered over, so a further change in either direction fails here and is noticed.
const [bunMajor, bunMinor] = Bun.version.split('.').map(Number);
const OVERSIZE_CLOSE = bunMajor > 1 || (bunMajor === 1 && bunMinor >= 4) ? 1009 : 1006;
test('serveBun: ws message size and inbound queue limits', async () => {
  const app = createApp({ modules: [M], limits: { maxWsMessageBytes: 1024, maxWsQueue: 4 } });
  const server = await serveBun(app, { port: 0 });
  const port = server.port;
  try {
    const atLimit = await exchange(port, '/rt/echo', ['a'.repeat(1024)], 300);
    expect(atLimit.replies).toEqual([`echo:${'a'.repeat(1024)}`]);

    const over = await exchange(port, '/rt/echo', ['a'.repeat(1025)]);
    expect(over.close?.code).toBe(OVERSIZE_CLOSE);

    const full = await exchange(port, '/rt/stall', ['1', '2', '3', '4', '5']);
    expect(full.close).toEqual({ code: 1013, reason: 'inbound queue full' });
  } finally {
    server.stop(true);
  }
});

test('serveBun: ws message size default is 1 MiB', async () => {
  const app = createApp({ modules: [M] });
  const server = await serveBun(app, { port: 0 });
  const port = server.port;
  try {
    const atLimit = await exchange(port, '/rt/echo', ['a'.repeat(1_048_576)], 500);
    expect(atLimit.replies.length).toBe(1);

    const over = await exchange(port, '/rt/echo', ['a'.repeat(1_048_577)]);
    expect(over.close?.code).toBe(OVERSIZE_CLOSE);
  } finally {
    server.stop(true);
  }
});

// CARD-21 (D17): the reserved mesh path is refused the way the Node listener refuses it, and a route
// that claims it fails createApp here too.
test('serveBun: /__mesh__/control without a control channel closes 1008; a route there fails createApp', async () => {
  @Route('/')
  class Claims {
    @Ws('/__mesh__/control')
    control() {
      return (async function* () {})();
    }
  }
  @Module({ mountpoint: '/', controllers: [Claims] })
  class ClaimsModule {}
  expect(() => createApp({ modules: [ClaimsModule] })).toThrow(
    /^route @Ws \/__mesh__\/control at Claims\.control uses the reserved path/,
  );

  const app = createApp({ modules: [M] });
  const server = await serveBun(app, { port: 0 });
  try {
    expect((await exchange(server.port, '/__mesh__/control', [])).close).toEqual({
      code: 1008,
      reason: 'mesh control channel not enabled: this app exports nothing, or has no mesh.secret',
    });
  } finally {
    server.stop(true);
  }
});
