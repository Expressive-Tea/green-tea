// CARD-16 (#112, D13): response compression on the Node adapter (`listen()`) and `app.fetch`.
// Negotiation T1–T6, skips T7/T8/T11, round trip T12, ETag interplay T10, 304 T15, ndjson T14, SSE
// per event T9, the edge rule through both signals (detection and `edgeHandler`), validation, and
// a client leaving mid-stream. Deno, Bun and workerd repeat what applies to them in their suites.
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { compressionApp, flood, JSON_BODY, HTML_BODY, BIG_BODY, SSE_EVENTS, SSE_GAP_MS } from './fixtures/compression-app';
import { negotiate, resolveCompression } from '../src/http/compression';
import { ticksDuringGzip } from './fixtures/compression-checks';
import { edgeHandler } from '../src/edge';

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Buffer;
}

/** Raw bytes off the socket: no client-side decoding, so a double encoding cannot hide. */
function get(port: number, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const decode = (bytes: Buffer, ce: string | undefined): string =>
  (ce === 'br' ? zlib.brotliDecompressSync(bytes) : ce === 'gzip' ? zlib.gunzipSync(bytes) : bytes).toString('utf8');

const ae = (value?: string): Record<string, string> => (value === undefined ? {} : { 'accept-encoding': value });

describe('negotiate() (RFC 9110 §12.5.3)', () => {
  const both = ['br', 'gzip'] as ('br' | 'gzip')[];
  it.each([
    ['gzip, br', 'br'], // T1: tie → server preference
    ['br;q=0, gzip', 'gzip'], // T2
    ['identity', undefined], // T3
    [undefined, undefined], // T3 (absent)
    ['*;q=0', undefined], // T4
    ['*', 'br'], // T5: first configured
    ['gzip;q=1, br;q=0.5', 'gzip'],
    ['gzip;q=0.5, *', 'br'],
    ['br;q=bogus, gzip', 'gzip'],
    // RFC 9110 §12.4.2 qvalues only: a malformed or out-of-range q excludes the member.
    ['gzip;q=2, br;q=1', 'br'],
    ['gzip;q=1e0', undefined],
    ['gzip;q=0.5000', undefined],
    ['gzip;q=-1', undefined],
    ['gzip;q=0.500, br;q=0.4', 'gzip'],
    ['gzip;q=1.000, br;q=1.', 'br'],
    ['GZIP', 'gzip'],
  ])('%s → %s', (header, expected) => {
    expect(negotiate(header, both)).toBe(expected);
  });

  it('T6: encodings [gzip], client accepts only br → identity', () => {
    expect(negotiate('br', ['gzip'])).toBeUndefined();
  });
});

describe('option validation (at createApp)', () => {
  it.each([
    { threshold: -1 },
    { threshold: 1.5 },
    { threshold: '1' },
    { encodings: [] },
    { encodings: ['zstd'] },
    { encodings: 'gzip' },
  ])('%j throws', (o) => {
    expect(() => compressionApp({ compression: o as never })).toThrow(TypeError);
  });

  it('a non-object throws; off by default', () => {
    expect(() => compressionApp({ compression: 'yes' as never })).toThrow(TypeError);
    expect(resolveCompression(undefined)).toBeUndefined();
    expect(resolveCompression(false)).toBeUndefined();
    expect(resolveCompression(true, () => true)).toEqual({ threshold: 1024, encodings: ['br', 'gzip'], encode: true });
  });
});

for (const adapter of ['node', 'fetch'] as const) {
  describe(`${adapter} adapter, compression: true`, () => {
    let close: () => Promise<void> = async () => {};
    let call: (path: string, headers?: Record<string, string>, method?: string) => Promise<Raw>;

    beforeAll(async () => {
      const app = compressionApp({ compression: true, etag: true });

      if (adapter === 'node') {
        const server = await app.listen(0);
        const port = (server.address() as AddressInfo).port;
        close = () => app.close();
        call = (p, h, m) => get(port, p, h, m);
      } else {
        call = async (p, h = {}, method = 'GET') => {
          const res = await app.fetch(new Request(`http://x${p}`, { method, headers: h }));
          const headers: http.IncomingHttpHeaders = {};
          res.headers.forEach((v, k) => (headers[k] = v));
          return { status: res.status, headers, bytes: Buffer.from(await res.arrayBuffer()) };
        };
      }
    });
    afterAll(() => close());

    it.each([
      ['/c/json', 'gzip, br', 'br', JSON_BODY],
      ['/c/json', 'br;q=0, gzip', 'gzip', JSON_BODY],
      ['/c/json', '*', 'br', JSON_BODY],
      ['/c/html', 'gzip', 'gzip', HTML_BODY],
      ['/c/html', 'br', 'br', HTML_BODY],
      ['/c/big', 'gzip', 'gzip', BIG_BODY],
      ['/c/big', 'br', 'br', BIG_BODY],
    ])('T1/T2/T5/T12 %s with %s → %s, decodes to the original bytes', async (path, accept, ce, original) => {
      const r = await call(path, ae(accept));
      expect(r.headers['content-encoding']).toBe(ce);
      expect(r.headers.vary).toMatch(/Accept-Encoding/i);
      expect(r.headers['content-length'] === undefined || Number(r.headers['content-length']) === r.bytes.length).toBe(
        true,
      );
      expect(decode(r.bytes, ce)).toBe(original); // one layer only: a second would not decode to this
    });

    it.each([['identity'], [undefined], ['*;q=0']])('T3/T4 Accept-Encoding %s → identity + Vary', async (accept) => {
      const r = await call('/c/json', ae(accept));
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(r.headers.vary).toMatch(/Accept-Encoding/i);
      expect(r.bytes.toString()).toBe(JSON_BODY);
    });

    it.each([
      ['/c/small', 'T7 under threshold', false],
      ['/c/png', 'T8 image/png', false],
      ['/c/notype', 'T8 missing content-type', false],
      ['/c/range', 'T8 content-range', false],
      ['/c/notransform', 'T11 no-transform', false],
    ])('%s (%s) is sent identity', async (path, _why, vary) => {
      const r = await call(path, ae('gzip, br'));
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(/accept-encoding/i.test(String(r.headers.vary ?? ''))).toBe(vary);
    });

    it('T8 handler-set content-encoding is passed through untouched (no double encoding)', async () => {
      const r = await call('/c/pre', ae('gzip, br'));
      expect(r.headers['content-encoding']).toBe('gzip');
      expect(r.bytes.toString()).toBe('y'.repeat(4096));
    });

    it('T8 HEAD and 204 are not encoded; HEAD keeps Vary, 204 gets none', async () => {
      const head = await call('/c/json', ae('gzip'), 'HEAD');
      expect(head.headers['content-encoding']).toBeUndefined();
      expect(head.headers.vary).toMatch(/Accept-Encoding/i);
      const empty = await call('/c/empty', ae('gzip'));
      expect(empty.status).toBe(204);
      expect(empty.headers['content-encoding']).toBeUndefined();
      expect(empty.headers.vary).toBeUndefined();
    });

    it('merges Vary with a handler Vary', async () => {
      const r = await call('/c/vary', ae('gzip'));
      expect(r.headers.vary).toBe('Origin, Accept-Encoding');
    });

    it('T15: a 304 (NotModified) carries Vary, no Content-Type and no body', async () => {
      const r = await call('/c/304', ae('gzip'));
      expect(r.status).toBe(304);
      expect(r.headers.vary).toMatch(/Accept-Encoding/i);
      expect(r.headers['content-type']).toBeUndefined();
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(r.bytes.length).toBe(0);
    });

    it('T10: etag + gzip → the same ETag as identity; the 304 carries Vary', async () => {
      const identity = await call('/c/plainjson', ae('identity'));
      const gz = await call('/c/plainjson', ae('gzip'));
      expect(gz.headers['content-encoding']).toBe('gzip');
      expect(gz.headers.etag).toMatch(/^W\//);
      expect(gz.headers.etag).toBe(identity.headers.etag);
      const nm = await call('/c/plainjson', { ...ae('gzip'), 'if-none-match': String(gz.headers.etag) });
      expect(nm.status).toBe(304);
      expect(nm.headers.vary).toMatch(/Accept-Encoding/i);
      expect(nm.headers.etag).toBe(gz.headers.etag);
      expect(nm.bytes.length).toBe(0);
    });

    it('a handler strong ETag stays strong on the encoded variant', async () => {
      const r = await call('/c/etag', ae('gzip'));
      expect(r.headers['content-encoding']).toBe('gzip');
      expect(r.headers.etag).toBe('"v1"');
    });

    it.each(['gzip', 'br'])('T14 ndjson stream is encoded with %s and decodes to the same lines', async (ce) => {
      const r = await call('/c/ndjson', ae(ce));
      expect(r.headers['content-encoding']).toBe(ce);
      expect(r.headers.vary).toMatch(/Accept-Encoding/i);
      expect(decode(r.bytes, ce)).toBe('{"n":0}\n{"n":1}\n{"n":2}\n');
    });

    it('a stream to an identity client gets Vary and is not encoded', async () => {
      const r = await call('/c/ndjson', ae('identity'));
      expect(r.headers['content-encoding']).toBeUndefined();
      expect(r.headers.vary).toMatch(/Accept-Encoding/i);
      expect(r.bytes.toString()).toBe('{"n":0}\n{"n":1}\n{"n":2}\n');
    });
  });
}

describe('custom options', () => {
  it('T6 encodings [gzip] with a br-only client → identity; threshold lowers the floor', async () => {
    const app = compressionApp({ compression: { encodings: ['gzip'], threshold: 0 } });
    const br = await app.fetch(new Request('http://x/c/small', { headers: ae('br') }));
    expect(br.headers.get('content-encoding')).toBeNull();
    const gz = await app.fetch(new Request('http://x/c/small', { headers: ae('gzip') }));
    expect(gz.headers.get('content-encoding')).toBe('gzip');
  });
});

describe('edge: core never encodes, Vary only', () => {
  const identityWithVary = async (app: ReturnType<typeof compressionApp>) => {
    for (const path of ['/c/json', '/c/ndjson']) {
      const res = await app.fetch(new Request(`http://x${path}`, { headers: ae('gzip, br') }));
      expect(res.headers.get('content-encoding'), path).toBeNull();
      expect(res.headers.get('vary'), path).toMatch(/Accept-Encoding/i);
      await res.arrayBuffer();
    }
  };

  it('detected at createApp from navigator.userAgent (bare app.fetch)', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    try {
      await identityWithVary(compressionApp({ compression: true }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('marked by edgeHandler even when detection sees nothing', async () => {
    const app = compressionApp({ compression: true });
    edgeHandler(app);
    await identityWithVary(app);
  });

  it('edgeHandler on an app without compression is harmless', async () => {
    const app = compressionApp();
    const res = await edgeHandler(app)(new Request('http://x/c/json', { headers: ae('gzip') }));
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
  });
});

describe('T9 SSE per-event delivery with compression (Node listen())', () => {
  it.each(['gzip', 'br'])('%s: event n is readable before event n+1 is produced', async (ce) => {
    const app = compressionApp({ compression: true });
    const server = await app.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      const lags = await new Promise<number[]>((resolve, reject) => {
        http
          .get({ port, path: '/c/sse', headers: { 'accept-encoding': ce, accept: 'text/event-stream' } }, (res) => {
            expect(res.headers['content-encoding']).toBe(ce);
            const dec = ce === 'br' ? zlib.createBrotliDecompress() : zlib.createGunzip();
            const out: number[] = [];
            let buf = '';
            dec.on('data', (d: Buffer) => {
              buf += d.toString();
              let i;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const m = buf.slice(0, i).match(/data: (\{.*\})/);
                buf = buf.slice(i + 2);
                if (m) out.push(Date.now() - JSON.parse(m[1]).t);
              }
            });
            res.pipe(dec);
            dec.on('end', () => resolve(out));
            dec.on('error', reject);
          })
          .on('error', reject);
      });

      expect(lags).toHaveLength(SSE_EVENTS);
      // Each event decodes well inside the gap before the next one is even produced.
      for (const lag of lags) expect(lag).toBeLessThan(SSE_GAP_MS / 2);
    } finally {
      await app.close();
    }
  });
});

describe('client disconnect mid-stream', () => {
  it.each(['gzip', 'br'])('Node %s: the stream closes and the compressor is torn down', async (ce) => {
    const app = compressionApp({ compression: true });
    const closed = new Promise<void>((resolve) => app.bus.on('stream:close', () => resolve()));
    const server = await app.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ port, path: '/c/forever', headers: { 'accept-encoding': ce } }, (res) => {
          expect(res.headers['content-encoding']).toBe(ce);
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        });
        req.on('error', () => {});
        setTimeout(() => reject(new Error('no data')), 2000);
      });
      await closed;
    } finally {
      await app.close();
    }
  });

  it.each(['gzip', 'br'])('app.fetch %s: cancelling the body cancels the source', async (ce) => {
    const app = compressionApp({ compression: true });
    const closed = new Promise<void>((resolve) => app.bus.on('stream:close', () => resolve()));
    const res = await app.fetch(new Request('http://x/c/forever', { headers: ae(ce) }));
    expect(res.headers.get('content-encoding')).toBe(ce);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    await closed;
  });
});

describe('slow client backpressure (Node)', () => {
  it.each(['gzip', 'br'])('%s: a client that stops reading stops the producer', async (ce) => {
    const app = compressionApp({ compression: true });
    const server = await app.listen(0);
    const port = (server.address() as AddressInfo).port;

    try {
      const req = http.get({ port, path: '/c/flood', headers: { 'accept-encoding': ce } }, (res) => {
        expect(res.headers['content-encoding']).toBe(ce);
        res.pause(); // never read
      });
      req.on('error', () => {});
      // Each frame is ~28 KB of nearly incompressible text. Without backpressure the generator never
      // stops; with it, it stops once the socket, the response and the compressor's buffers are full.
      // How many frames that takes depends on the kernel's socket buffers (Linux auto-tunes them to
      // several MB), so wait for production to stall rather than for a fixed time.
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let previous = -1;

      for (let waited = 0; flood.produced !== previous; waited += 200) {
        expect(waited, `still producing after ${waited} ms: ${flood.produced} frames`).toBeLessThan(10_000);
        previous = flood.produced;
        await sleep(200);
      }

      const stalled = flood.produced;
      await sleep(500);
      expect(flood.produced - stalled).toBeLessThanOrEqual(1);
      expect(stalled).toBeLessThan(2000);
      req.destroy();
    } finally {
      flood.produced = 0;
      await app.close();
    }
  }, 20_000);
});

describe('documented runtime behaviour (Node)', () => {
  it("node:zlib's async gzip runs off the main thread, so the loop keeps ticking", async () => {
    const { ms, ticks } = await ticksDuringGzip();
    expect(ms).toBeGreaterThan(50);
    expect(ticks).toBeGreaterThan(ms / 4);
  });
});
