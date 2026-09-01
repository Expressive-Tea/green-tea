import { describe, it, expect, vi } from 'vitest';
import { buildSecurityHeaders, resolveCors, mergeVary, isValidOrigin } from '../src/security';

describe('buildSecurityHeaders', () => {
  it('default set (security:true), no HSTS over insecure', () => {
    const h = buildSecurityHeaders(true, false);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('SAMEORIGIN');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['x-dns-prefetch-control']).toBe('off');
    expect(h['strict-transport-security']).toBeUndefined();
  });
  it('HSTS only when secure', () => {
    const h = buildSecurityHeaders(true, true);
    expect(h['strict-transport-security']).toBe('max-age=15552000');
  });
  it('security:false → empty', () => {
    expect(buildSecurityHeaders(false, true)).toEqual({});
  });
  it('object overrides: disable frameOptions, custom referrer, csp, hsts opts', () => {
    const h = buildSecurityHeaders({ frameOptions: false, referrerPolicy: 'strict-origin',
      csp: "default-src 'self'", hsts: { maxAge: 100, includeSubDomains: true } }, true);
    expect(h['x-frame-options']).toBeUndefined();
    expect(h['referrer-policy']).toBe('strict-origin');
    expect(h['content-security-policy']).toBe("default-src 'self'");
    expect(h['strict-transport-security']).toBe('max-age=100; includeSubDomains');
  });
});

describe('resolveCors', () => {
  const req = (origin?: string) => ({ headers: origin ? { origin } : {} });
  it('exact-string allowlist echoes origin + Vary', () => {
    const r = resolveCors({ origins: 'https://a.com' }, req('https://a.com') as any);
    expect(r['access-control-allow-origin']).toBe('https://a.com');
    expect(r['vary']).toBe('Origin');
  });
  it('disallowed origin → no allow-origin header', () => {
    const r = resolveCors({ origins: 'https://a.com' }, req('https://evil.com') as any);
    expect(r['access-control-allow-origin']).toBeUndefined();
  });
  it("'*' without credentials returns *", () => {
    const r = resolveCors({ origins: '*' }, req('https://a.com') as any);
    expect(r['access-control-allow-origin']).toBe('*');
  });
  it('credentials:true never returns * — echoes concrete origin', () => {
    const r = resolveCors({ origins: '*', credentials: true }, req('https://a.com') as any);
    expect(r['access-control-allow-origin']).toBe('https://a.com');
    expect(r['access-control-allow-credentials']).toBe('true');
  });
  it('rejects malformed Origin (control char) even if predicate allows', () => {
    const r = resolveCors({ origins: () => true }, req('https://a.com\r\nX: y') as any);
    expect(r['access-control-allow-origin']).toBeUndefined();
  });

  // An `origins` predicate is the whole reason the option takes a function: an allowlist in Redis, a
  // tenant lookup, a regex over a parsed URL. Every one of those has a failure mode, and it runs on
  // the request path — so a throw must not leave the boundary.
  describe('a predicate that throws', () => {
    const boom = () => {
      throw new Error('lookup failed');
    };

    it('denies the origin rather than escaping the request path', () => {
      expect(() => resolveCors({ origins: boom }, req('https://a.com') as any)).not.toThrow();
      expect(resolveCors({ origins: boom }, req('https://a.com') as any)).toEqual({});
    });

    it('fails closed even when credentials are on — a broken allowlist is not an open one', () => {
      const r = resolveCors({ origins: boom, credentials: true }, req('https://a.com') as any);
      expect(r['access-control-allow-origin']).toBeUndefined();
      expect(r['access-control-allow-credentials']).toBeUndefined();
    });

    it('reports the failure through the logger instead of swallowing it', () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      resolveCors({ origins: boom }, req('https://a.com') as any, logger as any);
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn.mock.calls[0][0]).toMatch(/cors/i);
    });
  });
});

describe('isValidOrigin', () => {
  it('accepts valid origins and literal null', () => {
    expect(isValidOrigin('https://a.com')).toBe(true);
    expect(isValidOrigin('http://localhost:3000')).toBe(true);
    expect(isValidOrigin('null')).toBe(true);
  });
  it('rejects CRLF and other control bytes', () => {
    expect(isValidOrigin('https://a.com\r\nX: y')).toBe(false);
    expect(isValidOrigin('https://a.com\x00evil')).toBe(false);
    expect(isValidOrigin('https://a.com\x1bevil')).toBe(false);
  });
});

describe('mergeVary', () => {
  it('appends, dedupes, handles empty', () => {
    expect(mergeVary(undefined, 'Origin')).toBe('Origin');
    expect(mergeVary('Accept-Encoding', 'Origin')).toBe('Accept-Encoding, Origin');
    expect(mergeVary('Origin', 'Origin')).toBe('Origin');
  });
});
