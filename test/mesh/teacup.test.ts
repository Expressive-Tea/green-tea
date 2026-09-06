import { describe, it, expect } from 'vitest';
import { buildRemote, envelopeFrom } from '../../src/mesh/teacup';
import type { Link } from '../../src/mesh/link';

const fakeLink = (calls: any[]): Link => ({
  manifest: { steps: ['config', 'auth'], routes: [{ method: 'GET', pattern: '/u/:id' }] },
  rpc: async (kind, name, ctx) => { calls.push({ kind, name, ctx }); return name === 'config' ? { url: 'db://x' } : { id: 'u1' }; },
  close() {},
});

describe('teacup buildRemote', () => {
  it('turns every manifest step into a lazy remote node', async () => {
    const link = { manifest: { steps: ['auth'], routes: [] }, rpc: async () => ({ ok: true }) } as any;
    const { steps, routes } = buildRemote(link);

    expect(routes).toEqual([]);
    expect(steps.map((s: any) => s.name)).toEqual(['auth']);
    expect(await steps[0].run({})).toEqual({ auth: { ok: true } });
  });

  it('makes a step node per manifest token, with RPC runners returning merge objects', async () => {
    const calls: any[] = [];
    const { steps } = buildRemote(fakeLink(calls));
    expect(steps.map((s) => s.name)).toEqual(['config', 'auth']);
    expect(await steps[0].run({})).toEqual({ config: { url: 'db://x' } });
    const ctx = { req: {}, params: { id: '9' }, query: {}, body: undefined, headers: { x: '1' } };
    expect(await steps[1].run(ctx)).toEqual({ auth: { id: 'u1' } });
    expect(calls.find((c) => c.name === 'auth').ctx).toMatchObject({ params: { id: '9' }, headers: { x: '1' } });
  });

  it('makes a proxy route entry with method+pattern', async () => {
    const calls: any[] = [];
    const { routes } = buildRemote(fakeLink(calls));
    expect(routes[0]).toMatchObject({ method: 'GET', pattern: '/u/:id' });
  });

  it('envelopeFrom extracts only serializable request fields', () => {
    const env = envelopeFrom({ method: 'POST', params: { a: '1' }, query: { q: 'x' }, body: { n: 1 }, headers: { h: 'v' }, db: { find() {} } } as any);
    expect(env).toEqual({ method: 'POST', params: { a: '1' }, query: { q: 'x' }, body: { n: 1 }, headers: { h: 'v' } });
  });
});
