import { describe, it, expect } from 'vitest';
import { parseMultipart, extractBoundary } from '../src/multipart';

const B = 'X-BOUND';
function body(parts: string[]): Buffer {
  return Buffer.concat([...parts.map((p) => Buffer.from(`--${B}\r\n${p}\r\n`)), Buffer.from(`--${B}--\r\n`)]);
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
  it('single text field is decoded', async () => {
    const r = await parseMultipart(body([field('title', 'hello')]), B, opts);
    expect(r.fields.title).toBe('hello');
  });

  it('multiple distinct fields', async () => {
    const r = await parseMultipart(body([field('a', '1'), field('b', '2')]), B, opts);
    expect(r.fields).toEqual({ a: '1', b: '2' });
  });

  it("duplicates 'last' vs 'array'", async () => {
    const b = body([field('t', 'x'), field('t', 'y')]);
    expect((await parseMultipart(b, B, { maxParts: 1000, duplicates: 'last' })).fields.t).toBe('y');
    expect((await parseMultipart(b, B, { maxParts: 1000, duplicates: 'array' })).fields.t).toEqual(['x', 'y']);
  });

  it('single file: metadata + exact bytes incl. embedded CRLF and dashes', async () => {
    // A real boundary is a random token that never appears in content; this exercises CRLF + `--` runs.
    const payload = 'ab\r\ncd\r\n--decoy--\r\nef';
    const r = await parseMultipart(body([file('doc', 'a.txt', 'text/plain', payload)]), B, opts);
    const f = r.files.doc as any;
    expect(f.filename).toBe('a.txt');
    expect(f.contentType).toBe('text/plain');
    expect(f.size).toBe(Buffer.byteLength(payload));
    expect(f.data.toString()).toBe(payload);
  });

  it('multiple files same name → array', async () => {
    const r = await parseMultipart(
      body([file('f', '1', 'text/plain', 'a'), file('f', '2', 'text/plain', 'b')]),
      B,
      opts,
    );
    expect(Array.isArray(r.files.f)).toBe(true);
    expect((r.files.f as any).length).toBe(2);
  });

  it('mixed fields + files', async () => {
    const r = await parseMultipart(body([field('name', 'joe'), file('avatar', 'p.png', 'image/png', 'PNG')]), B, opts);
    expect(r.fields.name).toBe('joe');
    expect((r.files.avatar as any).filename).toBe('p.png');
  });

  it('case-insensitive headers + filename-before-name (order independent)', async () => {
    const part = `content-disposition: form-data; filename="z.bin"; name="up"\r\ncontent-type: application/octet-stream\r\n\r\nDATA`;
    const r = await parseMultipart(body([part]), B, opts);
    expect((r.files.up as any).filename).toBe('z.bin');
  });

  it('filename="" with empty body is skipped', async () => {
    const part = `Content-Disposition: form-data; name="up"; filename=""\r\n\r\n`;
    const r = await parseMultipart(body([part]), B, opts);
    expect(r.files.up).toBeUndefined();
  });

  it('more parts than maxParts → rejects', async () => {
    const b = body([field('a', '1'), field('b', '2'), field('c', '3')]);
    await expect(parseMultipart(b, B, { maxParts: 2, duplicates: 'last' })).rejects.toThrow();
  });

  it('malformed input with no matching boundary → rejects', async () => {
    await expect(parseMultipart(Buffer.from('garbage'), B, opts)).rejects.toThrow();
  });
});
