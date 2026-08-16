import { describe, it, expect } from 'vitest';
import { asReadableStream, toBodyInit } from '../src/http/web';
import { sseEncoder } from '../src/encoders';

async function* nums() { yield { n: 1 }; yield { n: 2 }; }

describe('toBodyInit', () => {
  it('passes a string through untouched', () => {
    expect(toBodyInit('hello')).toBe('hello');
  });

  // `Buffer.from` allocates inside a shared 8 KB pool, so these bytes sit at a non-zero byteOffset.
  // A conversion that re-views the backing store without the offset and length returns the entire
  // pool — every other allocation in it included. Asserting the length alone catches that.
  it('re-views a pooled Buffer as its own bytes, not the whole pool', async () => {
    const buf = Buffer.from([0x00, 0x89, 0xff, 0xfe, 0x0a]);
    expect(buf.byteOffset).toBeGreaterThan(0); // guards the premise: this Buffer really is pooled
    expect(buf.buffer.byteLength).toBeGreaterThan(buf.byteLength);

    const bytes = new Uint8Array(await new Response(toBodyInit(buf)).arrayBuffer());
    expect(bytes.byteLength).toBe(5);
    expect([...bytes]).toEqual([0x00, 0x89, 0xff, 0xfe, 0x0a]);
  });

  it('does not copy — the view shares the backing store', () => {
    const buf = Buffer.from([1, 2, 3]);
    expect((toBodyInit(buf) as Uint8Array).buffer).toBe(buf.buffer);
  });
});

describe('asReadableStream', () => {
  it('encodes each yielded value with the encoder', async () => {
    const rs = asReadableStream(nums(), sseEncoder);
    const text = await new Response(rs).text();
    expect(text).toContain('data: {"n":1}');
    expect(text).toContain('data: {"n":2}');
  });

  it('cancels the source iterator when the stream is cancelled', async () => {
    let returned = false;
    async function* forever() { try { while (true) yield { t: 1 }; } finally { returned = true; } }
    const rs = asReadableStream(forever(), sseEncoder);
    const reader = rs.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(returned).toBe(true);
  });
});
