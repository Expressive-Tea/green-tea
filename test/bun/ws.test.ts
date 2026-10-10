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

// #107: Bun refuses an oversized frame natively (`maxPayloadLength`), before buffering it. Its
// uWebSockets core drops the TCP connection without a close frame, so the peer sees `1006`, not
// the `1009` Node, Deno and the edge send. Asserted rather than papered over: it is the documented
// Bun difference, and a Bun upgrade that starts sending 1009 should fail here and be noticed.
test('serveBun: ws message size and inbound queue limits', async () => {
  const app = createApp({ modules: [M], limits: { maxWsMessageBytes: 1024, maxWsQueue: 4 } });
  const server = await serveBun(app, { port: 0 });
  const port = server.port;
  try {
    const atLimit = await exchange(port, '/rt/echo', ['a'.repeat(1024)], 300);
    expect(atLimit.replies).toEqual([`echo:${'a'.repeat(1024)}`]);

    const over = await exchange(port, '/rt/echo', ['a'.repeat(1025)]);
    expect(over.close?.code).toBe(1006);

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
    expect(over.close?.code).toBe(1006);
  } finally {
    server.stop(true);
  }
});
