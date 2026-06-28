import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { connectLink } from '../../src/mesh/link';
import { encode, decode } from '../../src/mesh/protocol';

const env = { method: 'GET', params: {}, query: {}, body: undefined, headers: {} };

// teapot that validates secret 'good', returns a manifest, answers scope rpc (boom -> error)
function startTeapot(secret = 'good') {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    let authed = false;
    ws.on('message', (d) => {
      const f = decode(d.toString());
      if (!authed) {
        if (f.type === 'hello' && f.secret === secret) { authed = true; ws.send(encode({ type: 'manifest', scopes: [{ token: 'auth', scope: 'request' }], routes: [] })); }
        else ws.close(1008);
        return;
      }
      if (f.type === 'rpc-req') {
        if (f.name === 'boom') ws.send(encode({ type: 'rpc-res', id: f.id, ok: false, error: { message: 'denied', status: 403 } }));
        else ws.send(encode({ type: 'rpc-res', id: f.id, ok: true, result: { got: f.name } }));
      }
    });
  });
  const port = (wss.address() as any).port;
  return { url: `ws://127.0.0.1:${port}/__mesh__/control`, close: () => wss.close() };
}

// teapot that completes the handshake but NEVER answers rpc-req (for timeout)
function startSilentTeapot(secret = 'good') {
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const f = decode(d.toString());
      if (f.type === 'hello' && f.secret === secret) ws.send(encode({ type: 'manifest', scopes: [], routes: [] }));
      // ignore rpc-req entirely
    });
  });
  const port = (wss.address() as any).port;
  return { url: `ws://127.0.0.1:${port}/__mesh__/control`, close: () => wss.close() };
}

describe('connectLink', () => {
  it('handshakes and exposes the manifest', async () => {
    const t = startTeapot();
    const link = await connectLink({ url: t.url, secret: 'good' });
    expect(link.manifest.scopes).toEqual([{ token: 'auth', scope: 'request' }]);
    link.close(); t.close();
  });

  it('rpc resolves a result by id', async () => {
    const t = startTeapot();
    const link = await connectLink({ url: t.url, secret: 'good' });
    expect(await link.rpc('scope', 'auth', env)).toEqual({ got: 'auth' });
    link.close(); t.close();
  });

  it('rpc rejects with an HttpError carrying the remote status', async () => {
    const t = startTeapot();
    const link = await connectLink({ url: t.url, secret: 'good' });
    await expect(link.rpc('scope', 'boom', env)).rejects.toMatchObject({ status: 403, message: 'denied' });
    link.close(); t.close();
  });

  it('rejects connect on bad secret', async () => {
    const t = startTeapot();
    await expect(connectLink({ url: t.url, secret: 'wrong', timeoutMs: 500 })).rejects.toThrow();
    t.close();
  });

  it('times out an rpc when the teapot never answers', async () => {
    const t = startSilentTeapot();
    const link = await connectLink({ url: t.url, secret: 'good', timeoutMs: 150 });
    await expect(link.rpc('scope', 'whatever', env)).rejects.toThrow(/timeout/i);
    link.close(); t.close();
  });
});
