import { describe, expect, it } from 'vitest';
import { render, escapeHtml, contentTypeFor } from '../src/views';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('render', () => {
  it('interpolates and HTML-escapes {{ x }} by default', () => {
    expect(render('<h1>{{ name }}</h1>', { name: '<b>hi</b>' })).toBe('<h1>&lt;b&gt;hi&lt;/b&gt;</h1>');
  });
  it('leaves {{{ x }}} raw (unescaped)', () => {
    expect(render('{{{ html }}}', { html: '<b>hi</b>' })).toBe('<b>hi</b>');
  });
  it('resolves nested keys and renders missing keys as empty', () => {
    expect(render('{{ user.name }}|{{ nope }}', { user: { name: 'Diego' } })).toBe('Diego|');
  });
});

describe('contentTypeFor', () => {
  it('maps known extensions and defaults unknown to octet-stream', () => {
    expect(contentTypeFor('.css')).toBe('text/css; charset=utf-8');
    expect(contentTypeFor('.PNG')).toBe('image/png');
    expect(contentTypeFor('.xyz')).toBe('application/octet-stream');
  });
});
