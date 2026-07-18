import { describe, it, expect } from 'vitest';
import { mergeInjectedHeaders } from '../src/http/headers';

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
