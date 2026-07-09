import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { createApp, Provider, Route, Get, Post, Module, needs, body, Sse } from '../src/index';

@Provider({ provides: 'db' })
class Db {
  provide() {
    return { db: { v: 42 } };
  }
}
@Route('/api')
class Ctl {
  @Get('/x') x(@needs('db') d: any) {
    return { v: d.v };
  }
  @Post('/y') y(@body() b: any) {
    return { echo: b };
  }
  @Sse('/s') s() {
    return (async function* () {
      yield { n: 1 };
      yield { n: 2 };
    })();
  }
}
@Module({ mountpoint: '/', providers: [Db], controllers: [Ctl] })
class M {}
const app = createApp({ modules: [M], cors: { origins: ['https://a.test'], credentials: false } });

// `app.listen` returns a Promise, so it's acquired in `beforeAll` rather than via a top-level
// `await` — this repo's tsconfig (module: commonjs, target: es2017) doesn't support top-level await.
let server: Server;
let base: string;

beforeAll(async () => {
  server = await app.listen(0);
  const port = (server.address() as any).port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => server.close());

const norm = (h: Headers) => {
  const o: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k !== 'date' && k !== 'connection' && k !== 'keep-alive' && k !== 'content-length' && k !== 'transfer-encoding')
      o[k] = v;
  });
  return o;
};

async function both(path: string, init?: RequestInit) {
  const node = await fetch(base + path, init);
  const web = await app.fetch(new Request(base + path, init));
  return { node, web };
}

describe('Node vs app.fetch parity (Node is truth)', () => {
  it('GET /api/x', async () => {
    const { node, web } = await both('/api/x');
    expect(web.status).toBe(node.status);
    expect(norm(web.headers)).toEqual(norm(node.headers));
    expect(await web.json()).toEqual(await node.json());
  });
  it('POST /api/y', async () => {
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) };
    const { node, web } = await both('/api/y', init);
    expect(web.status).toBe(node.status);
    expect(await web.json()).toEqual(await node.json());
  });
  it('404', async () => {
    const { node, web } = await both('/missing');
    expect(web.status).toBe(node.status);
    expect(norm(web.headers)).toEqual(norm(node.headers));
  });
  it('CORS preflight', async () => {
    const init = { method: 'OPTIONS', headers: { origin: 'https://a.test', 'access-control-request-method': 'GET' } };
    const { node, web } = await both('/api/x', init);
    expect(web.status).toBe(node.status);
    expect(norm(web.headers)).toEqual(norm(node.headers));
  });
  it('SSE first two events', async () => {
    const nodeText = await (await fetch(base + '/api/s')).text();
    const webText = await (await app.fetch(new Request(base + '/api/s'))).text();
    expect(webText).toBe(nodeText);
  });
});
