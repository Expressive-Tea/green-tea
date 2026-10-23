import { describe, it, expect } from 'vitest';
import { mergeInjectedHeaders, joinListHeaders, toWebHeaders } from '../src/http/headers';

describe('mergeInjectedHeaders', () => {
  it('makes injected keys authoritative regardless of handler casing', () => {
    const out = mergeInjectedHeaders(
      { 'Content-Type': 'text/html', 'X-Content-Type-Options': 'sniffme' },
      { 'x-content-type-options': 'nosniff' },
    );
    expect(out['x-content-type-options']).toBe('nosniff');
    expect(Object.keys(out).filter((k) => k.toLowerCase() === 'x-content-type-options')).toHaveLength(1);
    expect(out['Content-Type']).toBe('text/html'); // untouched handler header kept
  });

  it('merges Vary from handler and injected', () => {
    const out = mergeInjectedHeaders({ Vary: 'Accept' }, { vary: 'Origin' });
    expect(out['vary'].toLowerCase()).toContain('accept');
    expect(out['vary'].toLowerCase()).toContain('origin');
  });

  it('preserves handler Vary when no injected Vary', () => {
    const out = mergeInjectedHeaders({ Vary: 'Accept' }, {});
    expect(out['vary']).toBe('Accept');
  });
});

describe('array header values (D11)', () => {
  it('keeps a handler array intact and still merges vary', () => {
    const cookies = ['a=1', 'b=2'];
    const out = mergeInjectedHeaders({ 'set-cookie': cookies, Vary: ['Accept', 'Accept-Language'] }, { vary: 'Origin' });
    expect(out['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(out['vary']).toBe('Accept, Accept-Language, Origin');
  });

  it('joinListHeaders joins every array but set-cookie, and returns the input when there is none', () => {
    const plain = { a: '1' };
    expect(joinListHeaders(plain)).toBe(plain);
    expect(joinListHeaders({ 'Set-Cookie': ['a=1', 'b=2'], 'x-list': ['a', 'b'] })).toEqual({
      'Set-Cookie': ['a=1', 'b=2'],
      'x-list': 'a, b',
    });
  });

  it('toWebHeaders appends one set-cookie per element', () => {
    const h = toWebHeaders({ 'set-cookie': ['a=1; Expires=Tue, 01 Jan 2030 00:00:00 GMT', 'b=2'], 'x-list': ['a', 'b'] });
    expect(h.getSetCookie()).toEqual(['a=1; Expires=Tue, 01 Jan 2030 00:00:00 GMT', 'b=2']);
    expect(h.get('x-list')).toBe('a, b');
  });
});
