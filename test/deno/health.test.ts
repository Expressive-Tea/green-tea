// CARD-17 T1–T3 on Deno: the probe states a load balancer reads. T1 goes through `app.fetch`, because
// `serveDeno` boots before it binds and so never answers while booting; T2 and T3 go through a real
// `serveDeno` listener. T5 (the drain window) lives in `shutdown.test.ts`.
//
// Run with: npm run test:deno
import 'reflect-metadata';
import { createApp, Route, Get, Module, Provider } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

@Route('/')
class Ctl {
  @Get('/ping')
  ping() {
    return { ok: true };
  }
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

async function expectProbe(res: Response, status: number, body: unknown): Promise<void> {
  const got = await res.json();
  if (res.status !== status || JSON.stringify(got) !== JSON.stringify(body)) {
    throw new Error(`expected ${status} ${JSON.stringify(body)}, got ${res.status} ${JSON.stringify(got)}`);
  }
}

Deno.test('CARD-17 T1: /__ready__ 503 booting while a slow provider boots, /__live__ 200', async () => {
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
  await new Promise((r) => setTimeout(r, 10));

  await expectProbe(await app.fetch(new Request('http://x/__ready__')), 503, { status: 'booting' });
  await expectProbe(await app.fetch(new Request('http://x/__live__')), 200, { status: 'ok' });

  finish();
  await booting;
  await expectProbe(await app.fetch(new Request('http://x/__ready__')), 200, { status: 'ok' });
});

Deno.test('CARD-17 T2: serveDeno, booted with nothing degraded → 200 ok', async () => {
  @Module({ mountpoint: '/', controllers: [Ctl] })
  class M {}
  const server = await serveDeno(createApp({ modules: [M], health: true, logger: quiet }), {
    port: 0,
    onListen: () => {},
  });
  try {
    const base = `http://127.0.0.1:${(server as unknown as { addr: { port: number } }).addr.port}`;
    await expectProbe(await fetch(`${base}/__ready__`), 200, { status: 'ok' });
    await expectProbe(await fetch(`${base}/__live__`), 200, { status: 'ok' });
  } finally {
    await server.close();
  }
});

Deno.test('CARD-17 T3: serveDeno, an optional provider failed → 200 degraded with its name', async () => {
  @Provider({ provides: 'x', optional: true })
  class X {
    provide(): never {
      throw new Error('down');
    }
  }
  @Module({ mountpoint: '/', controllers: [Ctl], providers: [X] })
  class D {}
  const server = await serveDeno(createApp({ modules: [D], health: true, logger: quiet }), {
    port: 0,
    onListen: () => {},
  });
  try {
    const base = `http://127.0.0.1:${(server as unknown as { addr: { port: number } }).addr.port}`;
    await expectProbe(await fetch(`${base}/__ready__`), 200, { status: 'degraded', degraded: ['x'] });
  } finally {
    await server.close();
  }
});
