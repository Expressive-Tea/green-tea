import { describe, it, expect } from 'vitest';
import { buildRemote, envelopeFrom } from '../../src/mesh/teacup';
import type { Link } from '../../src/mesh/link';

const fakeLink = (calls: any[]): Link => ({
  manifest: { scopes: [{ token: 'config', scope: 'app' }, { token: 'auth', scope: 'request' }], routes: [{ method: 'GET', pattern: '/u/:id' }] },
  rpc: async (kind, name, ctx) => { calls.push({ kind, name, ctx }); return name === 'config' ? { url: 'db://x' } : { id: 'u1' }; },
  close() {},
});

describe('teacup buildRemote', () => {
  it('makes a provider node (app) and a step node (request) with RPC runners returning merge objects', async () => {
    const calls: any[] = [];
    const { providers, steps } = buildRemote(fakeLink(calls), 'ws://t');
    expect(providers.map((p) => p.name)).toEqual(['config']);
    expect(steps.map((s) => s.name)).toEqual(['auth']);
    expect(await providers[0].run({})).toEqual({ config: { url: 'db://x' } });
    const ctx = { req: {}, params: { id: '9' }, query: {}, body: undefined, headers: { x: '1' } };
    expect(await steps[0].run(ctx)).toEqual({ auth: { id: 'u1' } });
    expect(calls.find((c) => c.name === 'auth').ctx).toMatchObject({ params: { id: '9' }, headers: { x: '1' } });
  });

  it('makes a proxy route entry with method+pattern', async () => {
    const calls: any[] = [];
    const { routes } = buildRemote(fakeLink(calls), 'ws://t');
    expect(routes[0]).toMatchObject({ method: 'GET', pattern: '/u/:id' });
  });

  it('envelopeFrom extracts only serializable request fields', () => {
    const env = envelopeFrom({ method: 'POST', params: { a: '1' }, query: { q: 'x' }, body: { n: 1 }, headers: { h: 'v' }, db: { find() {} } } as any);
    expect(env).toEqual({ method: 'POST', params: { a: '1' }, query: { q: 'x' }, body: { n: 1 }, headers: { h: 'v' } });
  });
});
