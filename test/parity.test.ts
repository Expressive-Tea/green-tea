import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { connect } from 'net';
import { createApp, Provider, Route, Get, Head, Options, Post, Module, needs, body, Sse } from '../src/index';

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
  @Get('/implicit-head') implicitHead() {
    return { from: 'get' };
  }
  @Get('/explicit-head') explicitHeadGet() {
    return { from: 'get' };
  }
  @Head('/explicit-head') explicitHead() {
    return { from: 'head' };
  }
  @Get('/explicit-options') explicitOptionsGet() {
    return { from: 'get' };
  }
  @Options('/explicit-options') explicitOptions() {
    return { from: 'options' };
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

/**
 * Sends a request line verbatim, bypassing `fetch`.
 *
 * `both()` cannot reach the cases below: `fetch()` normalizes the URL before it hits the wire, and
 * `new Request()` does the same, so a dot segment written into either is already resolved by the
 * time the adapter sees it. Only a hand-written request line proves what Node does with one.
 */
function rawStatus(target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(base).port), '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.on('data', (chunk) => (raw += chunk.toString()));
    socket.on('error', reject);
    socket.on('end', () => resolve(Number(raw.split(' ')[1])));
  });
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
  it('implicit and explicit HEAD return no body in both adapters', async () => {
    for (const path of ['/api/implicit-head', '/api/explicit-head']) {
      const { node, web } = await both(path, { method: 'HEAD' });
      expect(node.status).toBe(200);
      expect(web.status).toBe(node.status);
      expect(await node.text()).toBe('');
      expect(await web.text()).toBe('');
    }
  });
  it('automatic OPTIONS is 204 with the same canonical Allow header', async () => {
    const { node, web } = await both('/api/x', { method: 'OPTIONS' });
    expect(node.status).toBe(204);
    expect(web.status).toBe(204);
    expect(node.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    expect(web.headers.get('allow')).toBe(node.headers.get('allow'));
  });
  it('explicit OPTIONS route runs normally', async () => {
    const { node, web } = await both('/api/explicit-options', { method: 'OPTIONS' });
    expect(node.status).toBe(200);
    expect(web.status).toBe(200);
    expect(await node.json()).toEqual({ from: 'options' });
    expect(await web.json()).toEqual({ from: 'options' });
  });
  it('rejects repeated slashes and malformed encoding with secure 400 responses', async () => {
    for (const path of ['/api//x', '/api/%E0%A4%A']) {
      const { node, web } = await both(path);
      expect(node.status).toBe(400);
      expect(web.status).toBe(400);
      expect(node.headers.get('x-content-type-options')).toBe('nosniff');
      expect(web.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });
  // Regression: the same bytes on the wire used to route differently per runtime. Deno, Bun and
  // workerd resolve dot segments inside the `Request` constructor before green-tea sees anything,
  // and the raw target is unrecoverable there — so Node had to be taught to resolve them too.
  it('resolves dot segments to the same route the fetch adapter reaches', async () => {
    for (const target of ['/api/nope/../x', '/api/./x', '/api/nope/%2e%2e/x', '/nope/../api/x']) {
      expect(await rawStatus(target), `node ${target}`).toBe(200);
      expect((await app.fetch(new Request(base + target))).status, `fetch ${target}`).toBe(200);
    }
  });

  it('does not treat dots inside a segment as dot segments', async () => {
    expect(await rawStatus('/api/x.y')).toBe(404);
    expect((await app.fetch(new Request(base + '/api/x.y'))).status).toBe(404);
  });

  it('SSE first two events', async () => {
    const nodeText = await (await fetch(base + '/api/s')).text();
    const webText = await (await app.fetch(new Request(base + '/api/s'))).text();
    expect(webText).toBe(nodeText);
  });
});
