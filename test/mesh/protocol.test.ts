import { describe, it, expect } from 'vitest';
import { encode, decode, type Frame, type RequestEnvelope } from '../../src/mesh/protocol';

const env: RequestEnvelope = { method: 'GET', params: { id: '1' }, query: {}, body: undefined, headers: {} };

describe('protocol codec', () => {
  it('round-trips each frame type', () => {
    const frames: Frame[] = [
      { type: 'hello', secret: 's3cr3t' },
      { type: 'manifest', scopes: [{ token: 'auth', scope: 'request' }], routes: [{ method: 'GET', pattern: '/u/:id' }] },
      { type: 'rpc-req', id: 'c1:1', kind: 'scope', name: 'auth', ctx: env },
      { type: 'rpc-res', id: 'c1:1', ok: true, result: { id: 'u1' } },
      { type: 'rpc-res', id: 'c1:2', ok: false, error: { message: 'no', status: 401 } },
    ];
    for (const f of frames) expect(decode(encode(f))).toEqual(f);
  });

  it('throws on malformed json', () => {
    expect(() => decode('{not json')).toThrow();
  });

  it('throws on unknown frame type', () => {
    expect(() => decode(JSON.stringify({ type: 'bogus' }))).toThrow(/unknown frame/i);
  });
});
