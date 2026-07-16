import { describe, it, expect, vi } from 'vitest';
import { buildManifest, createMeshControl } from '../../src/mesh/teapot';
import { encode, decode, MESH_PROTOCOL_VERSION } from '../../src/mesh/protocol';
import { channel } from '../../src/channel';
import type { WsSocket } from '../../src/http/ws-core';
import { Unauthorized } from '../../src/signals';

const V = MESH_PROTOCOL_VERSION;

/** Lets the control loop drain: it consumes `inbound` asynchronously and does not await RPCs. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * A fake neutral WsSocket — the same capability `nodeSocket` builds on Node and `app.upgrade`
 * hands over on Deno/Bun. `close` also ends `inbound`, mirroring a real socket's close.
 */
const fakeSocket = () => {
  const inbound = channel<unknown>();
  const ac = new AbortController();
  const sent: any[] = [];
  const close = vi.fn((_code?: number, _reason?: string) => {
    inbound.close();
    ac.abort();
  });
  const socket: WsSocket = {
    inbound,
    abort: ac.signal,
    isOpen: true,
    send: (data: string) => {
      sent.push(decode(data));
    },
    close,
    terminate: () => ac.abort(),
  };

  /** Deliver a frame the way a peer would, then let the loop process it. */
  const deliver = async (frame: unknown) => {
    inbound.push(encode(frame as never));
    await settle();
  };

  return { socket, sent, close, deliver, inbound };
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
  const manifest = buildManifest({
    providers: ['config'],
    steps: ['auth'],
    routes: [{ method: 'GET', pattern: '/u/:id' }],
  });
  const make = (over: Partial<Parameters<typeof createMeshControl>[0]> = {}) =>
    createMeshControl({
      secret: 'good',
      manifest,
      resolveScope: async (name) => ({ resolved: name }),
      resolveRoute: async () => ({ status: 200, headers: {}, body: 'route-body' }),
      ...over,
    });

  it('exposes the reserved control path', () => {
    expect(make().path).toBe('/__mesh__/control');
  });

  it('rejects a bad secret and closes', async () => {
    const t = fakeSocket();
    make().handle(t.socket);
    await t.deliver({ type: 'hello', v: V, secret: 'wrong' });
    expect(t.close).toHaveBeenCalledWith(1008);
    expect(t.sent).toEqual([]);
  });

  it('answers a good hello with the manifest, stamped with the protocol version', async () => {
    const t = fakeSocket();
    make().handle(t.socket);
    await t.deliver({ type: 'hello', v: V, secret: 'good' });
    expect(t.sent[0]).toMatchObject({ type: 'manifest', v: V, scopes: manifest.scopes });
  });

  it('rejects a version-skewed peer before checking its secret, naming both versions', async () => {
    const t = fakeSocket();
    make().handle(t.socket);
    // correct secret, wrong protocol: must still be refused — and not as an auth failure
    await t.deliver({ type: 'hello', v: V + 1, secret: 'good' });
    expect(t.sent).toEqual([]);
    const [code, reason] = t.close.mock.calls[0];
    expect(code).toBe(1008);
    expect(reason).toContain(String(V));
    expect(reason).toContain(String(V + 1));
  });

  it('refuses a version-skewed peer even when its secret is also wrong', async () => {
    const t = fakeSocket();
    make().handle(t.socket);
    await t.deliver({ type: 'hello', v: V + 1, secret: 'wrong' });
    expect(t.sent).toEqual([]);
    expect(t.close).toHaveBeenCalled();
  });

  it('does NOT process rpc before handshake', async () => {
    const t = fakeSocket();
    make().handle(t.socket);
    await t.deliver({ type: 'rpc-req', id: '1', kind: 'scope', name: 'config', ctx: {} });
    expect(t.sent).toEqual([]);
  });

  it('resolves an exported scope after handshake', async () => {
    const t = fakeSocket();
    make().handle(t.socket);
    await t.deliver({ type: 'hello', v: V, secret: 'good' });
    await t.deliver({ type: 'rpc-req', id: '7', kind: 'scope', name: 'config', ctx: {} });
    expect(t.sent.find((f: any) => f.type === 'rpc-res')).toEqual({
      type: 'rpc-res',
      id: '7',
      ok: true,
      result: { resolved: 'config' },
    });
  });

  it('rejects an unexported scope', async () => {
    const t = fakeSocket();
    make().handle(t.socket);
    await t.deliver({ type: 'hello', v: V, secret: 'good' });
    await t.deliver({ type: 'rpc-req', id: '8', kind: 'scope', name: 'secretsvc', ctx: {} });
    const res: any = t.sent.find((f: any) => f.type === 'rpc-res');
    expect(res.ok).toBe(false);
    expect(res.error.status).toBe(403);
  });

  it('propagates a thrown HttpError status in the error frame', async () => {
    const t = fakeSocket();
    make({
      resolveScope: async () => {
        throw new Unauthorized('nope');
      },
    }).handle(t.socket);
    await t.deliver({ type: 'hello', v: V, secret: 'good' });
    await t.deliver({ type: 'rpc-req', id: '9', kind: 'scope', name: 'config', ctx: {} });
    const res: any = t.sent.find((f: any) => f.type === 'rpc-res');
    expect(res).toMatchObject({ id: '9', ok: false, error: { message: 'nope', status: 401 } });
  });

  it('serves overlapping RPCs concurrently rather than head-of-line blocking', async () => {
    // the loop must not await handleRpc: a slow call would otherwise stall every later one.
    // fast is delivered second but resolves first, which can only happen if they overlap.
    const t = fakeSocket();
    make({
      resolveScope: async (name) => {
        if (name === 'config') await new Promise((r) => setTimeout(r, 30));
        return { resolved: name };
      },
    }).handle(t.socket);
    await t.deliver({ type: 'hello', v: V, secret: 'good' });
    t.inbound.push(encode({ type: 'rpc-req', id: 'slow', kind: 'scope', name: 'config', ctx: {} as never }));
    t.inbound.push(encode({ type: 'rpc-req', id: 'fast', kind: 'scope', name: 'auth', ctx: {} as never }));
    await new Promise((r) => setTimeout(r, 60));

    const ids = t.sent.filter((f: any) => f.type === 'rpc-res').map((f: any) => f.id);
    expect(ids).toEqual(['fast', 'slow']);
  });
});
