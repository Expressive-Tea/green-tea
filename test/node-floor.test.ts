import { describe, expect, it, vi } from 'vitest';

// The `engines` floor is `>=18`, and the global `crypto` only arrived unflagged in Node 19. That gap
// shipped once: `correlateRequest` compiled cleanly against an ambient declaration and then threw
// `ReferenceError: crypto is not defined` on the first request of every Node 18 process.
//
// CI's Node 18 job is what caught it, and this test is what makes it catchable without one — every
// developer machine and every other runtime has the global, so the bug is invisible where it is
// written. Stubbing the global away reproduces the floor's condition on any Node.
//
// If the floor ever moves above 18, this test and the fallback it guards can both go.
describe('correlateRequest without a global crypto (Node 18)', () => {
  it('falls back to node:crypto instead of throwing ReferenceError', async () => {
    vi.stubGlobal('crypto', undefined);
    vi.resetModules();

    const { correlateRequest } = await import('../src/http/core');
    const a = correlateRequest({});
    const b = correlateRequest({});

    expect(a.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a.requestId).not.toBe(b.requestId);
    expect(correlateRequest({ 'x-request-id': 'from-gateway' }).requestId).toBe('from-gateway');

    vi.unstubAllGlobals();
  });
});
