// CARD-16 (#112, D13): one app shared by the Node, Deno, Bun and edge compression tests, so every
// runtime is checked against the same routes and the same bytes (T12). Lifted from the D13 spike
// (`spike/d13-compression-b`). Import `reflect-metadata` first.
//
// Bodies are deterministic (seeded LCG), identical to the spikes' harness: a 10,205 B JSON and a
// 51,108 B HTML page — the HTML is also the body of the Deno memory check.
import { createApp, Route, Get, Head, Sse, Stream, Module, Transformer, NotModified } from '../../src/index';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(' ');

export const JSON_BODY: string = (() => {
  const r = rng(42);
  const items: unknown[] = [];
  let s = '';
  for (let i = 0; s.length < 10240; i++) {
    items.push({
      id: i,
      uuid: Array.from({ length: 4 }, () => Math.floor(r() * 2 ** 32).toString(16).padStart(8, '0')).join('-'),
      name: `${WORDS[Math.floor(r() * 16)]} ${WORDS[Math.floor(r() * 16)]}`,
      price: Math.round(r() * 100000) / 100,
      active: r() > 0.5,
      tags: [WORDS[Math.floor(r() * 16)], WORDS[Math.floor(r() * 16)]],
    });
    s = JSON.stringify({ items });
  }
  return JSON.stringify({ items: items.slice(0, items.length - 1) });
})();

export const HTML_BODY: string = (() => {
  const r = rng(7);
  const w = () => WORDS[Math.floor(r() * 16)];
  let s =
    '<!doctype html><html><head><meta charset="utf-8"><title>Spike</title><style>body{font-family:sans-serif}.row{display:flex;gap:8px}</style></head><body><main>';
  let i = 0;
  while (s.length < 51200 - 200) {
    s += `<div class="row" data-id="${i++}"><a href="/item/${Math.floor(r() * 1e6)}">${w()} ${w()}</a><span class="price">${(r() * 1000).toFixed(2)}</span><p>${w()} ${w()} ${w()} ${w()} ${w()} ${w()}.</p></div>\n`;
  }
  return s + '</main></body></html>';
})();

export const SMALL_BODY = JSON.stringify({ pad: 'x'.repeat(500) }); // 512 B, under the 1024 threshold
export const BIG_BODY = HTML_BODY.repeat(2); // 102 KiB
const PNG = 'P'.repeat(4096);
const TEXT = 'y'.repeat(4096);

const raw = (headers: Record<string, string>, status = 200) => (body: unknown) => ({
  status,
  headers,
  body: body as string,
});

/** How many frames `/c/flood` has produced, across every request. */
export const flood = { produced: 0 };

export const SSE_EVENTS = 5;
export const SSE_GAP_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Route('/c')
class Compressible {
  @Get('/json') @Transformer(raw({ 'content-type': 'application/json' })) json() {
    return JSON_BODY;
  }
  @Head('/json') @Transformer(raw({ 'content-type': 'application/json' })) headJson() {
    return JSON_BODY;
  }
  @Get('/html') @Transformer(raw({ 'Content-Type': 'text/html; charset=utf-8' })) html() {
    return HTML_BODY;
  }
  @Get('/big') @Transformer(raw({ 'content-type': 'text/html' })) big() {
    return BIG_BODY;
  }
  @Get('/small') @Transformer(raw({ 'content-type': 'application/json' })) small() {
    return SMALL_BODY;
  }
  @Get('/png') @Transformer(raw({ 'content-type': 'image/png' })) png() {
    return PNG;
  }
  @Get('/notype') @Transformer(raw({})) notype() {
    return TEXT;
  }
  @Get('/pre') @Transformer(raw({ 'content-type': 'text/plain', 'content-encoding': 'gzip' })) pre() {
    return TEXT; // not really gzip: core must leave it byte-for-byte alone
  }
  @Get('/range')
  @Transformer(raw({ 'content-type': 'text/plain', 'content-range': 'bytes 0-4095/8192' }, 206))
  range() {
    return TEXT;
  }
  @Get('/notransform') @Transformer(raw({ 'content-type': 'text/plain', 'cache-control': 'no-transform' })) nt() {
    return TEXT;
  }
  @Get('/vary') @Transformer(raw({ 'content-type': 'text/plain', vary: 'Origin' })) vary() {
    return TEXT;
  }
  @Get('/empty') @Transformer(raw({ 'content-type': 'text/plain' }, 204)) empty() {
    return '';
  }
  @Get('/etag') @Transformer(raw({ 'content-type': 'application/json', etag: '"v1"' })) etag() {
    return JSON_BODY;
  }
  @Get('/304') notModified() {
    throw new NotModified();
  }
  @Sse('/sse') async *sse() {
    for (let n = 0; n < SSE_EVENTS; n++) {
      if (n) await sleep(SSE_GAP_MS);
      yield { n, t: Date.now() };
    }
  }
  @Stream('/ndjson') async *ndjson() {
    for (let n = 0; n < 3; n++) yield { n };
  }
  @Get('/plainjson') plainJson() {
    return JSON.parse(JSON_BODY); // through the default JsonTransformer, for the ETag interplay (T10)
  }
  /** Large, poorly compressible frames as fast as they are pulled: the slow-client backpressure case. */
  @Stream('/flood') async *flood() {
    const r = rng(9);
    for (;;) {
      flood.produced++;
      yield { pad: Array.from({ length: 4096 }, () => Math.floor(r() * 2 ** 32).toString(36)).join('') };
    }
  }
  /** Never ends on its own: the client-disconnect case. */
  @Sse('/forever') async *forever() {
    for (let n = 0; ; n++) {
      yield { n, pad: 'z'.repeat(256) };
      await sleep(5);
    }
  }
}

@Module({ mountpoint: '/', controllers: [Compressible] })
class CompressionModule {}

/** The fixture app; `opts` is spread into `createApp` (`compression`, `etag`, …). */
export const compressionApp = (opts: Omit<Parameters<typeof createApp>[0], 'modules'> = {}) =>
  createApp({ modules: [CompressionModule], ...opts });
