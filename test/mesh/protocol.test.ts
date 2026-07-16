import { describe, it, expect } from 'vitest';
import { encode, decode, MESH_PROTOCOL_VERSION, type Frame, type RequestEnvelope } from '../../src/mesh/protocol';

const env: RequestEnvelope = { method: 'GET', params: { id: '1' }, query: {}, body: undefined, headers: {} };
const V = MESH_PROTOCOL_VERSION;

describe('protocol codec', () => {
  it('round-trips each frame type', () => {
    const frames: Frame[] = [
      { type: 'hello', v: V, secret: 's3cr3t' },
      {
        type: 'manifest',
        v: V,
        scopes: [{ token: 'auth', scope: 'request' }],
        routes: [{ method: 'GET', pattern: '/u/:id' }],
      },
      { type: 'rpc-req', id: '1', kind: 'scope', name: 'auth', ctx: env },
      { type: 'rpc-res', id: '1', ok: true, result: { id: 'u1' } },
      { type: 'rpc-res', id: '2', ok: false, error: { message: 'no', status: 401 } },
    ];
    for (const f of frames) expect(decode(encode(f))).toEqual(f);
  });

  it('throws on malformed json', () => {
    expect(() => decode('{not json')).toThrow();
  });

  it('throws on unknown frame type', () => {
    expect(() => decode(JSON.stringify({ type: 'bogus' }))).toThrow(/unknown frame/i);
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'treats inherited Object property %s as an unknown type, not a validator',
    (type) => {
      // `type` is peer-controlled; a bare SHAPE[type] lookup would walk the prototype chain
      expect(() => decode(JSON.stringify({ type }))).toThrow(/unknown frame/i);
    },
  );

  it('throws on a non-string type tag', () => {
    expect(() => decode(JSON.stringify({ type: 42 }))).toThrow(/unknown frame/i);
    expect(() => decode(JSON.stringify({}))).toThrow(/unknown frame/i);
  });
});

describe('protocol versioning', () => {
  it('carries the protocol version on the handshake frames', () => {
    const hello = decode(encode({ type: 'hello', v: V, secret: 's' }));
    const manifest = decode(encode({ type: 'manifest', v: V, scopes: [], routes: [] }));

    expect(hello).toMatchObject({ v: V });
    expect(manifest).toMatchObject({ v: V });
  });

  it('rejects a handshake frame with no version — an unversioned peer is not decodable', () => {
    expect(() => decode(JSON.stringify({ type: 'hello', secret: 's' }))).toThrow(/malformed hello/i);
    expect(() => decode(JSON.stringify({ type: 'manifest', scopes: [], routes: [] }))).toThrow(/malformed manifest/i);
  });
});

describe('protocol field validation', () => {
  // decode is the trust boundary: past it, teapot.ts feeds frames straight into
  // resolveScope/resolveRoute. A bad shape must die here, not downstream.
  it.each([
    ['hello without secret', { type: 'hello', v: V }],
    ['hello with non-string secret', { type: 'hello', v: V, secret: 42 }],
    ['manifest with non-array scopes', { type: 'manifest', v: V, scopes: 'nope', routes: [] }],
    ['rpc-req without id', { type: 'rpc-req', kind: 'scope', name: 'auth', ctx: env }],
    ['rpc-req without ctx', { type: 'rpc-req', id: '1', kind: 'scope', name: 'auth' }],
    ['rpc-req with unknown kind', { type: 'rpc-req', id: '1', kind: 'bogus', name: 'auth', ctx: env }],
    ['rpc-req without name', { type: 'rpc-req', id: '1', kind: 'scope', ctx: env }],
    ['rpc-res without id', { type: 'rpc-res', ok: true, result: 1 }],
    ['rpc-res with non-boolean ok', { type: 'rpc-res', id: '1', ok: 'yes' }],
    ['rpc-res error without an error payload', { type: 'rpc-res', id: '1', ok: false }],
  ])('rejects %s', (_label, frame) => {
    expect(() => decode(JSON.stringify(frame))).toThrow(/malformed/i);
  });

  it('accepts a valid rpc-req unchanged', () => {
    const frame: Frame = { type: 'rpc-req', id: '1', kind: 'route', name: '/u/:id', ctx: env };

    expect(decode(encode(frame))).toEqual(frame);
  });
});
