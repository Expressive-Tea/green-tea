import { describe, it, expect } from 'vitest';
import { Bus } from '../src/bus';
import { asReadableStream, buildFetch, toBodyInit } from '../src/http/web';
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

describe('buildFetch request gate', () => {
  it('does not permanently exhaust the gate when CORS setup throws', async () => {
    let attempts = 0;

    const fetchHandler = buildFetch(
      [
        {
          method: 'GET',
          pattern: '/ok',
          transport: 'buffer',
          handler: async () => ({ status: 200, headers: {}, body: 'ok' }),
        },
      ],
      {
        limits: { maxConcurrentRequests: 2 },
        cors: {
          origins: () => {
            attempts++;
            if (attempts <= 2) throw new Error('transient CORS failure');
            return true;
          },
        },
      },
    );

    const request = () =>
      new Request('http://localhost/ok', {
        headers: { origin: 'https://example.com' },
      });

    await expect(fetchHandler(request())).rejects.toThrow('transient CORS failure');
    await expect(fetchHandler(request())).rejects.toThrow('transient CORS failure');

    const recovered = await fetchHandler(request());
    expect(recovered.status).toBe(200);
  });

  it('rejects requests above maxConcurrentRequests and releases the slot afterwards', async () => {
    let release!: () => void;
    let started!: () => void;

    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });

    const bus = new Bus();
    const ended: Array<{ method?: string; status?: number; requestId?: string }> = [];
    bus.on('request:end', (event) => {
      ended.push(event);
    });

    const fetchHandler = buildFetch(
      [
        {
          method: 'GET',
          pattern: '/slow',
          transport: 'buffer',
          handler: async () => {
            started();
            await blocked;
            return { status: 200, headers: {}, body: 'ok' };
          },
        },
      ],
      {
        bus,
        limits: { maxConcurrentRequests: 1 },
        cors: { origins: 'https://example.com' },
      },
    );

    const first = fetchHandler(new Request('http://localhost/slow'));
    await firstStarted;

    const rejected = await fetchHandler(
      new Request('http://localhost/slow', {
        headers: { origin: 'https://example.com' },
      }),
    );

    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('content-type')).toBe('application/json');
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(rejected.headers.get('access-control-allow-origin')).toBe('https://example.com');
    expect(rejected.headers.get('x-content-type-options')).toBe('nosniff');
    expect(rejected.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    await expect(rejected.json()).resolves.toEqual({ error: 'Service Unavailable' });

    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      method: 'GET',
      status: 503,
    });
    expect(ended[0].requestId).toBeTruthy();

    release();

    expect((await first).status).toBe(200);

    const afterRelease = await fetchHandler(new Request('http://localhost/slow'));
    expect(afterRelease.status).toBe(200);
  });
  it('releases the slot when a streaming handler returns', async () => {
    async function* stream() {
      yield { n: 1 };
      await new Promise(() => {});
    }

    const fetchHandler = buildFetch(
      [
        {
          method: 'GET',
          pattern: '/stream',
          transport: 'sse',
          handler: async () => ({ stream: stream() }),
        },
      ],
      { limits: { maxConcurrentRequests: 1 } },
    );

    const first = await fetchHandler(
      new Request('http://localhost/stream', {
        headers: { accept: 'text/event-stream' },
      }),
    );

    expect(first.status).toBe(200);

    // The first response stream is still open, but its request slot should
    // already be released once handle() has returned.
    const second = await fetchHandler(
      new Request('http://localhost/stream', {
        headers: { accept: 'text/event-stream' },
      }),
    );

    expect(second.status).toBe(200);

    await first.body?.cancel();
    await second.body?.cancel();
  });
});
