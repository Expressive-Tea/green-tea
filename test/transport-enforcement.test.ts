import { describe, expect, it } from 'vitest';
import { createApp, Route, Get, Sse, Module } from '../src/index';

@Route('/api')
class Ctl {
  @Get('/ok') ok() { return { ok: true }; }                    // buffered value — fine
  @Get('/leak') leak() { return (async function* () { yield 1; })(); }  // buffered + iterable — 500
  @Sse('/stream') stream() { return (async function* () { yield { n: 1 }; })(); }  // stream — fine
  @Sse('/empty') empty() { return { not: 'a stream' }; }       // stream + value — 500
}
@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}
const app = createApp({ modules: [M] });

describe('transport enforcement (integration)', () => {
  it('a normal buffered GET still returns its value', async () => {
    const res = await app.fetch(new Request('http://x/api/ok'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('a buffered GET that returns an AsyncIterable is a 500 mismatch', async () => {
    const res = await app.fetch(new Request('http://x/api/leak'));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('must return a value');
  });
  it('a normal SSE stream still streams', async () => {
    const res = await app.fetch(new Request('http://x/api/stream'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
  it('an SSE route that returns a plain value is a 500 mismatch', async () => {
    const res = await app.fetch(new Request('http://x/api/empty'));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('must return an AsyncIterable');
  });
});
