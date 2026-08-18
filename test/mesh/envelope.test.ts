import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { connectLink } from '../../src/mesh/link';
import { envelopeFrom } from '../../src/mesh/teacup';
import { createMeshControl } from '../../src/mesh/teapot';
import { encode, decode, MESH_PROTOCOL_VERSION, type RequestEnvelope } from '../../src/mesh/protocol';
import { Bus } from '../../src/bus';
import { createApp, Step, Route, Get, Module, needs } from '../../src/index';

@Step({ provides: 'auth', needs: [], export: true })
class Auth {
  run(ctx: any) {
    return { auth: { token: ctx.headers?.['x-token'] ?? 'anon' } };
  }
}
@Module({ mountpoint: '/api', steps: [Auth] })
class TeapotModule {}

@Route('/local')
class LocalCtl {
  @Get('/who')
  who(@needs('auth') auth: any) {
    return { auth };
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

const V = MESH_PROTOCOL_VERSION;
const env = { method: 'GET', params: {}, query: {}, body: undefined, headers: {} };

/** Drives a control handler with a scripted socket, capturing what it sends and how it closes. */
function fakeSocket() {
  const queue: string[] = [];
  let push: ((v: string) => void) | undefined;
  let done = false;
  const sent: string[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];

  return {
    sent,
    closes,
    feed: (frame: string) => (push ? push(frame) : queue.push(frame)),
    end: () => {
      done = true;
      push?.('');
    },
    socket: {
      get isOpen() {
        return !done;
      },
      abort: new AbortController().signal,
      send: (data: string) => sent.push(data),
      close: (code?: number, reason?: string) => {
        closes.push({ code, reason });
        done = true;
      },
      terminate: () => undefined,
      inbound: {
        async *[Symbol.asyncIterator]() {
          while (!done) {
            if (queue.length) {
              yield queue.shift()!;
              continue;
            }
            const next = await new Promise<string>((resolve) => (push = resolve));
            if (done) return;
            yield next;
          }
        },
      },
    },
  };
}


describe('envelopeFrom', () => {
  it('carries the url and the caller correlation off ctx.req', () => {
    const envelope = envelopeFrom({
      req: { method: 'POST', url: '/orders/7?x=1', requestId: 'req-1', traceId: 'trace-1' },
      params: { id: '7' },
      query: { x: '1' },
      headers: { 'x-token': 'abc' },
      body: { total: 10 },
    });

    expect(envelope.url).toBe('/orders/7?x=1');
    expect(envelope.correlation).toEqual({ requestId: 'req-1', traceId: 'trace-1' });
    expect(envelope.method).toBe('POST');
  });

  it('omits correlation entirely when the caller has none, rather than sending an empty one', () => {
    expect(envelopeFrom({ req: { method: 'GET', url: '/x' } })).not.toHaveProperty('correlation');
  });
});

describe('mesh rpc errors', () => {
  it('reports the token that failed, not the wire id', async () => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      let authed = false;
      ws.on('message', (data) => {
        const frame = decode(data.toString());
        if (!authed && frame.type === 'hello') {
          authed = true;
          ws.send(encode({ type: 'manifest', v: V, scopes: [{ token: 'billing', scope: 'request' }], routes: [] }));
          return;
        }
        if (frame.type === 'rpc-req') {
          ws.send(encode({ type: 'rpc-res', id: frame.id, ok: false, error: { message: 'nope', status: 403 } }));
        }
      });
    });
    const port = (wss.address() as { port: number }).port;
    const bus = new Bus();
    const seen: string[] = [];
    bus.on('mesh:rpc:error', (payload) => seen.push(String(payload.name)));

    const link = await connectLink({ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: 'x', bus });
    await expect(link.rpc('scope', 'billing', env)).rejects.toMatchObject({ status: 403 });

    // used to be "0" — the per-link counter — which no operator could match to anything
    expect(seen).toEqual(['billing']);
    link.close();
    wss.close();
  });
});

describe('teapot hardening', () => {
  const control = () =>
    createMeshControl({
      secret: 'good',
      manifest: { scopes: [{ token: 'auth', scope: 'request' }], routes: [] },
      resolveScope: async () => 'value',
      resolveRoute: async () => ({ status: 200, headers: {}, body: '' }),
    });

  it('hangs up on an oversized frame before parsing it', async () => {
    const fake = fakeSocket();
    const running = control().handle(fake.socket as never);

    fake.feed(`{"type":"hello","v":${V},"secret":"${'a'.repeat(4_000_001)}"}`);
    await running;

    expect(fake.closes[0]?.code).toBe(1009);
    // never answered: the frame died before decode, so no manifest went out
    expect(fake.sent).toEqual([]);
  });

  it('serves normally when a frame is under the cap', async () => {
    const fake = fakeSocket();
    const running = control().handle(fake.socket as never);

    fake.feed(encode({ type: 'hello', v: V, secret: 'good' }));
    await new Promise((r) => setTimeout(r, 10));
    fake.end();
    await running;

    expect(JSON.parse(fake.sent[0]).type).toBe('manifest');
  });
});

describe('correlation across the mesh', () => {
  it("the teapot's own events carry the caller's request id, not one it opened itself", async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: 'good' } });
    const server = await teapot.listen(0);
    const port = (server.address() as { port: number }).port;

    // what the teapot reports about its *own* work — the far end of the trace
    const far: Array<string | undefined> = [];
    teapot.bus.on('request:step:leave', (payload) => far.push(payload.requestId));

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: 'good' }] },
    });

    try {
      // the id a gateway would have set; core adopts it rather than minting a new one
      const res = await teacup.fetch(
        new Request('http://x/api/local/who', { headers: { 'x-request-id': 'from-the-gateway' } }),
      );
      expect(res.status).toBe(200);

      expect(far.length).toBeGreaterThan(0);
      // before this change the teapot saw no id at all, so a request crossing the mesh
      // became two unrelated investigations
      expect(new Set(far)).toEqual(new Set(['from-the-gateway']));
    } finally {
      await teacup.close();
      await teapot.close();
      server.close();
    }
  });
});

describe('cleartext secret warning', () => {
  it('warns for a remote ws:// teapot, and stays quiet for loopback', async () => {
    const remote: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => remote.push(m), error() {} };

    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: 'good' } });
    const server = await teapot.listen(0);
    const port = (server.address() as { port: number }).port;

    // loopback: there is no network path, so nothing to warn about
    const local = createApp({
      modules: [TeacupModule],
      experimental: true,
      logger,
      mesh: { teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: 'good' }] },
    });

    try {
      await local.fetch(new Request('http://x/api/local/who'));
      expect(remote.filter((m) => m.includes('not encrypted'))).toEqual([]);
    } finally {
      await local.close();
      await teapot.close();
      server.close();
    }
  });

  it('warns when the secret would cross a network in cleartext', async () => {
    const warned: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warned.push(m), error() {} };

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      logger,
      // unreachable on purpose: the warning is emitted before the connection is attempted,
      // because it is about what would be sent, not about what succeeded
      mesh: { teapots: [{ url: 'ws://10.255.255.1:9/__mesh__/control', secret: 'good' }], timeoutMs: 300 },
    });

    try {
      await expect(teacup.fetch(new Request('http://x/api/local/who'))).rejects.toThrow();
    } finally {
      await teacup.close();
    }

    expect(warned.some((m) => m.includes('not encrypted') && m.includes('wss://'))).toBe(true);
  });
});
