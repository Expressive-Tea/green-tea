import { describe, it, expect } from 'vitest';
import { parseMultipart, extractBoundary } from '../src/multipart';

const B = 'X-BOUND';
function body(parts: string[]): Buffer {
  return Buffer.concat([
    ...parts.map((p) => Buffer.from(`--${B}\r\n${p}\r\n`)),
    Buffer.from(`--${B}--\r\n`),
  ]);
}
const field = (name: string, val: string) => `Content-Disposition: form-data; name="${name}"\r\n\r\n${val}`;
const file = (name: string, fn: string, ct: string, data: string) =>
  `Content-Disposition: form-data; name="${name}"; filename="${fn}"\r\nContent-Type: ${ct}\r\n\r\n${data}`;
const opts = { maxParts: 1000, duplicates: 'last' as const };

describe('extractBoundary', () => {
  it('plain and quoted', () => {
    expect(extractBoundary('multipart/form-data; boundary=abc')).toBe('abc');
    expect(extractBoundary('multipart/form-data; boundary="a b"')).toBe('a b');
    expect(extractBoundary('multipart/form-data')).toBeUndefined();
  });
});

describe('parseMultipart', () => {
  it('single text field is NOT lost (first-part off-by-one guard)', () => {
    const r = parseMultipart(body([field('title', 'hello')]), B, opts);
    expect(r.fields.title).toBe('hello');
  });
  it('multiple distinct fields', () => {
    const r = parseMultipart(body([field('a', '1'), field('b', '2')]), B, opts);
    expect(r.fields).toEqual({ a: '1', b: '2' });
  });
  it("duplicates 'last' vs 'array'", () => {
    const b = body([field('t', 'x'), field('t', 'y')]);
    expect(parseMultipart(b, B, { maxParts: 1000, duplicates: 'last' }).fields.t).toBe('y');
    expect(parseMultipart(b, B, { maxParts: 1000, duplicates: 'array' }).fields.t).toEqual(['x', 'y']);
  });
  it('single file: metadata + exact bytes incl. embedded CRLF and boundary-like text', () => {
    const payload = 'ab\r\n--X-BOUNDnope\r\ncd';
    const r = parseMultipart(body([file('doc', 'a.txt', 'text/plain', payload)]), B, opts);
    const f = r.files.doc as any;
    expect(f.filename).toBe('a.txt');
    expect(f.contentType).toBe('text/plain');
    expect(f.size).toBe(Buffer.byteLength(payload));
    expect(f.data.toString()).toBe(payload);
  });
  it('multiple files same name → array', () => {
    const r = parseMultipart(body([file('f', '1', 'text/plain', 'a'), file('f', '2', 'text/plain', 'b')]), B, opts);
    expect(Array.isArray(r.files.f)).toBe(true);
    expect((r.files.f as any).length).toBe(2);
  });
  it('mixed fields + files', () => {
    const r = parseMultipart(body([field('name', 'joe'), file('avatar', 'p.png', 'image/png', 'PNG')]), B, opts);
    expect(r.fields.name).toBe('joe');
    expect((r.files.avatar as any).filename).toBe('p.png');
  });
  it('case-insensitive headers + filename-before-name (order independent)', () => {
    const part = `content-disposition: form-data; filename="z.bin"; name="up"\r\ncontent-type: application/octet-stream\r\n\r\nDATA`;
    const r = parseMultipart(body([part]), B, opts);
    expect((r.files.up as any).filename).toBe('z.bin');
  });
  it('filename="" with empty body is skipped', () => {
    const part = `Content-Disposition: form-data; name="up"; filename=""\r\n\r\n`;
    const r = parseMultipart(body([part]), B, opts);
    expect(r.files.up).toBeUndefined();
  });
  it('malformed → throws: no boundary present', () => {
    expect(() => parseMultipart(Buffer.from('garbage'), B, opts)).toThrow();
  });
  it('malformed → throws: part without name', () => {
    const part = `Content-Disposition: form-data\r\n\r\nx`;
    expect(() => parseMultipart(body([part]), B, opts)).toThrow();
  });
  it('malformed → throws: part with no header/body separator', () => {
    const raw = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="a"\r\n--${B}--\r\n`);
    expect(() => parseMultipart(raw, B, opts)).toThrow();
  });
  it('parts over maxParts → throws', () => {
    const b = body([field('a', '1'), field('b', '2'), field('c', '3')]);
    expect(() => parseMultipart(b, B, { maxParts: 2, duplicates: 'last' })).toThrow();
  });
});
