// CARD-17 T1–T3 on Bun: the probe states a load balancer reads. T1 goes through `app.fetch`, because
// `serveBun` boots before it binds and so never answers while booting; T2 and T3 go through a real
// `serveBun` listener. T5 (the drain window) lives in `shutdown.test.ts`.
//
// Run with: npm run test:bun  (or: bun test test/bun/)
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { createApp, Route, Get, Module, Provider } from '../../src/index.ts';
import { serveBun } from '../../src/bun.ts';

@Route('/')
class Ctl {
  @Get('/ping')
  ping() {
    return { ok: true };
  }
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function probe(res: Response) {
  return { status: res.status, body: await res.json() };
}

test('CARD-17 T1: /__ready__ 503 booting while a slow provider boots, /__live__ 200', async () => {
  let finish: () => void = () => {};
  @Provider({ provides: 'slowDb' })
  class SlowDb {
    async provide() {
      await new Promise<void>((resolve) => (finish = resolve));
      return { slowDb: {} };
    }
  }
  @Module({ mountpoint: '/', controllers: [Ctl], providers: [SlowDb] })
  class Slow {}

  const app = createApp({ modules: [Slow], health: true, logger: quiet });
  const booting = app.boot();
  await Bun.sleep(10);

  expect(await probe(await app.fetch(new Request('http://x/__ready__')))).toEqual({
    status: 503,
    body: { status: 'booting' },
  });
  expect(await probe(await app.fetch(new Request('http://x/__live__')))).toEqual({
    status: 200,
    body: { status: 'ok' },
  });

  finish();
  await booting;
  expect(await probe(await app.fetch(new Request('http://x/__ready__')))).toEqual({
    status: 200,
    body: { status: 'ok' },
  });
});

test('CARD-17 T2: serveBun, booted with nothing degraded → 200 ok', async () => {
  @Module({ mountpoint: '/', controllers: [Ctl] })
  class M {}
  const server = await serveBun(createApp({ modules: [M], health: true, logger: quiet }), { port: 0 });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await probe(await fetch(`${base}/__ready__`))).toEqual({ status: 200, body: { status: 'ok' } });
    expect(await probe(await fetch(`${base}/__live__`))).toEqual({ status: 200, body: { status: 'ok' } });
  } finally {
    await server.close();
  }
});

test('CARD-17 T3: serveBun, an optional provider failed → 200 degraded with its name', async () => {
  @Provider({ provides: 'x', optional: true })
  class X {
    provide(): never {
      throw new Error('down');
    }
  }
  @Module({ mountpoint: '/', controllers: [Ctl], providers: [X] })
  class D {}
  const server = await serveBun(createApp({ modules: [D], health: true, logger: quiet }), { port: 0 });
  try {
    expect(await probe(await fetch(`http://127.0.0.1:${server.port}/__ready__`))).toEqual({
      status: 200,
      body: { status: 'degraded', degraded: ['x'] },
    });
  } finally {
    await server.close();
  }
});
