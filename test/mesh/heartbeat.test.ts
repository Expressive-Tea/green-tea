import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { connectLink } from '../../src/mesh/link';
import { encode, decode, MESH_PROTOCOL_VERSION } from '../../src/mesh/protocol';

const V = MESH_PROTOCOL_VERSION;
const env = { method: 'GET', params: {}, query: {}, body: undefined, headers: {} };

/**
 * A teapot that handshakes and answers RPCs, and optionally ignores pings — the shape of a
 * half-open link: TCP still looks alive, the peer is not. Without a heartbeat a teacup only
 * finds out when a request pays the full rpc timeout.
 */
function startTeapot(opts: { answerPings: boolean }) {
  const wss = new WebSocketServer({ port: 0 });
  const seen: string[] = [];

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const frame = decode(data.toString());
      seen.push(frame.type);

      if (frame.type === 'hello') {
        ws.send(encode({ type: 'manifest', v: V, scopes: [{ token: 'auth', scope: 'request' }], routes: [] }));
      }
      if (frame.type === 'ping' && opts.answerPings) ws.send(encode({ type: 'pong' }));
      if (frame.type === 'rpc-req') ws.send(encode({ type: 'rpc-res', id: frame.id, ok: true, result: { got: 1 } }));
    });
  });

  const port = (wss.address() as any).port;
  return { url: `ws://127.0.0.1:${port}/__mesh__/control`, seen, close: () => wss.close() };
}

describe('mesh heartbeat', () => {
  it('pings the teapot and keeps the link alive while it pongs', async () => {
    const t = startTeapot({ answerPings: true });
    const link = await connectLink({ url: t.url, secret: 'good', heartbeatMs: 30 });

    await new Promise((r) => setTimeout(r, 120));

    expect(t.seen.filter((f) => f === 'ping').length).toBeGreaterThan(1);
    expect(await link.rpc('scope', 'auth', env)).toEqual({ got: 1 }); // still usable

    link.close();
    t.close();
  });

  it('closes the link when the teapot stops answering pings', async () => {
    // the half-open case: the socket never errors, the peer just stops talking
    const t = startTeapot({ answerPings: false });
    const link = await connectLink({ url: t.url, secret: 'good', heartbeatMs: 30, timeoutMs: 10_000 });

    await new Promise((r) => setTimeout(r, 200));

    // 503 immediately from the dead-link guard, not a 10s wait on the rpc timeout
    await expect(link.rpc('scope', 'auth', env)).rejects.toMatchObject({ status: 503 });

    t.close();
  });

  it('emits mesh:disconnect when the heartbeat gives up', async () => {
    const t = startTeapot({ answerPings: false });
    const seen: string[] = [];
    const bus = { emit: (e: string, p: any) => seen.push(`${e}:${p.name}`), on: () => () => {} } as any;
    const link = await connectLink({ url: t.url, secret: 'good', heartbeatMs: 30, bus });

    await new Promise((r) => setTimeout(r, 200));

    expect(seen.some((s) => s.startsWith('mesh:disconnect'))).toBe(true);

    link.close();
    t.close();
  });

  it('does not ping before the handshake completes', async () => {
    const t = startTeapot({ answerPings: true });
    const link = await connectLink({ url: t.url, secret: 'good', heartbeatMs: 30 });

    // hello must be first on the wire: an unauthenticated peer has no business pinging
    expect(t.seen[0]).toBe('hello');

    link.close();
    t.close();
  });
});
