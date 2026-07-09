import { describe, it, expect } from 'vitest';
import { asReadableStream } from '../src/http/web';
import { sseEncoder } from '../src/encoders';

async function* nums() { yield { n: 1 }; yield { n: 2 }; }

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
