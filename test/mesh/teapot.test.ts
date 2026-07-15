import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { buildManifest, createMeshControl } from '../../src/mesh/teapot';
import { encode, decode, MESH_PROTOCOL_VERSION } from '../../src/mesh/protocol';

const V = MESH_PROTOCOL_VERSION;
import { Unauthorized } from '../../src/signals';

const fakeWs = () => {
  const ws: any = new EventEmitter();
  ws.sent = [];
  ws.send = (s: string) => ws.sent.push(decode(s));
  ws.close = vi.fn();
  return ws;
};

describe('buildManifest', () => {
  it('maps providers to app scope and steps to request scope', () => {
    const m = buildManifest({ providers: ['config'], steps: ['auth'], routes: [{ method: 'GET', pattern: '/u/:id' }] });
    expect(m.scopes).toContainEqual({ token: 'config', scope: 'app' });
    expect(m.scopes).toContainEqual({ token: 'auth', scope: 'request' });
    expect(m.routes).toEqual([{ method: 'GET', pattern: '/u/:id' }]);
  });
});

describe('createMeshControl', () => {
  const manifest = buildManifest({ providers: ['config'], steps: ['auth'], routes: [{ method: 'GET', pattern: '/u/:id' }] });
  const make = (over: Partial<Parameters<typeof createMeshControl>[0]> = {}) => createMeshControl({
    secret: 'good', manifest,
    resolveScope: async (name) => ({ resolved: name }),
    resolveRoute: async () => ({ status: 200, headers: {}, body: 'route-body' }),
    ...over,
  });

  it('exposes the reserved control path', () => {
    expect(make().path).toBe('/__mesh__/control');
  });

  it('rejects a bad secret and closes', () => {
    const ws = fakeWs(); make().handle(ws);
    ws.emit('message', encode({ type: 'hello', v: V, secret: 'wrong' }));
    expect(ws.close).toHaveBeenCalledWith(1008);
    expect(ws.sent).toEqual([]);
  });

  it('answers a good hello with the manifest, stamped with the protocol version', () => {
    const ws = fakeWs(); make().handle(ws);
    ws.emit('message', encode({ type: 'hello', v: V, secret: 'good' }));
    expect(ws.sent[0]).toMatchObject({ type: 'manifest', v: V, scopes: manifest.scopes });
  });

  it('rejects a version-skewed peer before checking its secret, naming both versions', () => {
    const ws = fakeWs(); make().handle(ws);
    // correct secret, wrong protocol: must still be refused — and not as an auth failure
    ws.emit('message', encode({ type: 'hello', v: V + 1, secret: 'good' } as any));
    expect(ws.sent).toEqual([]);
    const [code, reason] = ws.close.mock.calls[0];
    expect(code).toBe(1008);
    expect(reason).toContain(String(V));
    expect(reason).toContain(String(V + 1));
  });

  it('refuses a version-skewed peer even when its secret is also wrong', () => {
    const ws = fakeWs(); make().handle(ws);
    ws.emit('message', encode({ type: 'hello', v: V + 1, secret: 'wrong' } as any));
    expect(ws.sent).toEqual([]);
    expect(ws.close).toHaveBeenCalled();
  });

  it('does NOT process rpc before handshake', async () => {
    const ws = fakeWs(); make().handle(ws);
    ws.emit('message', encode({ type: 'rpc-req', id: '1', kind: 'scope', name: 'config', ctx: {} as any }));
    await new Promise((r) => setTimeout(r, 5));
    expect(ws.sent).toEqual([]);
  });

  it('resolves an exported scope after handshake', async () => {
    const ws = fakeWs(); make().handle(ws);
    ws.emit('message', encode({ type: 'hello', v: V, secret: 'good' }));
    ws.emit('message', encode({ type: 'rpc-req', id: '7', kind: 'scope', name: 'config', ctx: {} as any }));
    await new Promise((r) => setTimeout(r, 5));
    expect(ws.sent.find((f: any) => f.type === 'rpc-res')).toEqual({ type: 'rpc-res', id: '7', ok: true, result: { resolved: 'config' } });
  });

  it('rejects an unexported scope', async () => {
    const ws = fakeWs(); make().handle(ws);
    ws.emit('message', encode({ type: 'hello', v: V, secret: 'good' }));
    ws.emit('message', encode({ type: 'rpc-req', id: '8', kind: 'scope', name: 'secretsvc', ctx: {} as any }));
    await new Promise((r) => setTimeout(r, 5));
    const res: any = ws.sent.find((f: any) => f.type === 'rpc-res');
    expect(res.ok).toBe(false);
    expect(res.error.status).toBe(403);
  });

  it('propagates a thrown HttpError status in the error frame', async () => {
    const ws = fakeWs();
    make({ resolveScope: async () => { throw new Unauthorized('nope'); } }).handle(ws);
    ws.emit('message', encode({ type: 'hello', v: V, secret: 'good' }));
    ws.emit('message', encode({ type: 'rpc-req', id: '9', kind: 'scope', name: 'config', ctx: {} as any }));
    await new Promise((r) => setTimeout(r, 5));
    const res: any = ws.sent.find((f: any) => f.type === 'rpc-res');
    expect(res).toMatchObject({ id: '9', ok: false, error: { message: 'nope', status: 401 } });
  });
});
