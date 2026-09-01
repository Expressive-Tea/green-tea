// `id:` on the wire, and the `Last-Event-ID` round-trip it exists to enable.
//
// `EventSource` reconnects on its own — that is the reason to pick SSE over a raw WebSocket. Until
// an `id:` was written the browser had nothing to send back, so every reconnect restarted the
// iterable from its beginning and lost the gap in silence. green-tea carries the marker both ways
// and stores nothing: what the gap means is the handler's call, because only the source knows
// whether it is replayable.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ndjsonEncoder, sse, sseEncoder } from '../src/encoders';
import { Module, Route, Sse } from '../src/metadata';
import { header } from '../src/params';
import { createApp } from '../src/app';

const frame = (item: unknown): string => String(sseEncoder.encode(item));

describe('sse() framing', () => {
  it('writes id: before data:', () => {
    expect(frame(sse({ t: 1 }, { id: '7' }))).toBe('id: 7\ndata: {"t":1}\n\n');
  });

  it('writes every field it was given, fields before data', () => {
    expect(frame(sse({ t: 1 }, { id: '7', event: 'tick', retry: 5000 }))).toBe(
      'retry: 5000\nevent: tick\nid: 7\ndata: {"t":1}\n\n',
    );
  });

  it('leaves a plain item exactly as it was', () => {
    // The whole point of the marker: an app that never calls sse() sees no change on the wire.
    expect(frame({ t: 1 })).toBe('data: {"t":1}\n\n');
  });

  it('keeps an empty id, which is how the spec resets the client s last event id', () => {
    expect(frame(sse({ t: 1 }, { id: '' }))).toBe('id: \ndata: {"t":1}\n\n');
  });

  it('cannot be talked into extra fields by a newline in the payload', () => {
    // JSON.stringify escapes the newline, so the data line stays single by construction.
    expect(frame({ note: 'a\nid: 99' })).toBe('data: {"note":"a\\nid: 99"}\n\n');
  });
});

describe('sse() rejects a field that would break the frame', () => {
  // An id is exactly the value most likely to come from a request — a cursor, a page token — so
  // this is a boundary, not a formatting nicety. Stripping would resume from the wrong place
  // silently, which is the bug this feature exists to close.
  for (const [label, id] of [
    ['newline', 'a\nid: 99'],
    ['carriage return', 'a\rid: 99'],
    ['NUL', 'a\0b'],
  ] as const) {
    it(`throws on a ${label} in id`, () => {
      expect(() => sse({ t: 1 }, { id })).toThrow(/may not contain a newline or a NUL/);
    });
  }

  it('throws on a newline in event', () => {
    expect(() => sse({ t: 1 }, { event: 'a\ndata: fake' })).toThrow(/'event' may not contain/);
  });

  it('throws on a fractional retry, which a browser would ignore', () => {
    expect(() => sse({ t: 1 }, { retry: 1.5 })).toThrow(/whole number of milliseconds/);
  });
});

describe('ndjson', () => {
  it('unwraps the payload and drops the SSE fields', () => {
    // A `negotiate` route yields the same items to both encoders. NDJSON has no frame to carry
    // id/event/retry and no resumption protocol to use them, so the client gets what it asked for.
    expect(String(ndjsonEncoder.encode(sse({ t: 1 }, { id: '7' })))).toBe('{"t":1}\n');
  });

  it('leaves a plain item alone', () => {
    expect(String(ndjsonEncoder.encode({ t: 1 }))).toBe('{"t":1}\n');
  });
});

describe('the Last-Event-ID round trip', () => {
  const app = (): ReturnType<typeof createApp> => {
    @Route('/')
    class Ctl {
      // Reading the header needs nothing new — the envelope has always carried it. What was
      // missing was the `id:` that gives the browser something to put in it.
      @Sse('/feed') feed(@header('last-event-id') from: string) {
        const start = from ? Number(from) + 1 : 1;
        return (async function* () {
          for (let n = start; n < start + 2; n++) yield sse({ n }, { id: String(n) });
        })();
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    return createApp({ modules: [M] });
  };

  it('serves ids, and resumes from the one the client sends back', async () => {
    const feed = app();

    const first = await (await feed.fetch(new Request('http://x/feed'))).text();
    expect(first).toBe('id: 1\ndata: {"n":1}\n\nid: 2\ndata: {"n":2}\n\n');

    // What EventSource does by itself on reconnect, spelled out.
    const resumed = await (
      await feed.fetch(new Request('http://x/feed', { headers: { 'last-event-id': '2' } }))
    ).text();
    expect(resumed).toBe('id: 3\ndata: {"n":3}\n\nid: 4\ndata: {"n":4}\n\n');
  });

  it('serves the same bytes over the Node adapter', async () => {
    // A different write path — `pipeStream` to a socket rather than a web ReadableStream — so
    // passing on `fetch` proves nothing about the runtime most apps deploy on.
    const feed = app();
    const server = await feed.listen(0);
    const { port } = server.address() as import('net').AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/feed`, { headers: { 'last-event-id': '9' } });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('id: 10\ndata: {"n":10}\n\nid: 11\ndata: {"n":11}\n\n');

    await feed.close();
  });

  it('refuses an id that would inject fields, rather than writing it', async () => {
    @Route('/')
    class Ctl {
      @Sse('/bad') bad() {
        return (async function* () {
          yield sse({ t: 1 }, { id: 'cursor\ndata: injected' });
        })();
      }
    }
    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    const broken = createApp({ modules: [M] });
    const errors: unknown[] = [];
    broken.bus.on('stream:error', (e) => errors.push(e.error));

    const body = await (await broken.fetch(new Request('http://x/bad'))).text();

    // Not `toContain`: the rejection quotes the offending value, so the text appears inside the
    // error payload — escaped, on one line. The claim is that no *field* was injected.
    expect(body.split('\n')).not.toContain('data: injected');
    expect(body).toContain('event: error');
    expect(errors).toHaveLength(1);
  });
});
