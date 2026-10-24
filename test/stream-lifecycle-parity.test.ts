// A stream's lifecycle must not depend on which adapter is serving it.
//
// `pipeStream` (Node) emitted `stream:open`/`:close`/`:error` and wrote the encoder's error frame.
// `asReadableStream` — the path every Fetch runtime takes, so Deno, Bun, workerd and `app.fetch()`
// on Node — emitted nothing and called `controller.error`. A consumer counting `stream:error` saw
// zero on three of the four runtimes, and the client got a truncated body indistinguishable from a
// clean end. Both halves are silent, which is what made it worth its own issue.
//
// Both adapters are driven from the same route table here on purpose: a table asserting one and
// then the other is how the two drift again.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Bus } from '../src/bus';
import { createHttpServer } from '../src/http';
import { buildFetch } from '../src/http/web';
import { resolveCompression } from '../src/http/compression';
import type { RouteDef } from '../src/http/types';

const events = (bus: Bus): string[] => {
  const seen: string[] = [];
  for (const name of ['stream:open', 'stream:close', 'stream:error'] as const)
    bus.on(name, () => seen.push(name));
  return seen;
};

const route = (handler: () => AsyncIterable<unknown>): RouteDef[] => [
  { method: 'GET', pattern: '/feed', transport: 'sse', handler: async () => ({ stream: handler() }) },
];

const clean = route(async function* () {
  yield { t: 1 };
});
const broken = route(async function* () {
  yield { t: 1 };
  throw new Error('source died');
});

/** Serves one request through the Node adapter and returns the body it wrote. */
async function overNode(routes: RouteDef[], bus: Bus): Promise<string> {
  const server = createHttpServer(routes, [], bus, undefined, {});
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };

  try {
    return await (await fetch(`http://127.0.0.1:${port}/feed`)).text();
  } finally {
    server.close();
  }
}

/** Serves one request through the Fetch adapter and returns the body it wrote. */
async function overFetch(routes: RouteDef[], bus: Bus): Promise<string> {
  return await (await buildFetch(routes, { bus })(new Request('http://x/feed'))).text();
}

const ADAPTERS = [
  { name: 'node', serve: overNode },
  { name: 'fetch', serve: overFetch },
] as const;

describe('stream lifecycle events, on every adapter', () => {
  for (const adapter of ADAPTERS) {
    it(`${adapter.name}: opens and closes a stream that ends normally`, async () => {
      const bus = new Bus();
      const seen = events(bus);

      expect(await adapter.serve(clean, bus)).toBe('data: {"t":1}\n\n');
      expect(seen).toEqual(['stream:open', 'stream:close']);
    });

    it(`${adapter.name}: reports a source that throws, and frames it for the client`, async () => {
      const bus = new Bus();
      const seen = events(bus);
      const errors: unknown[] = [];
      bus.on('stream:error', (e) => errors.push(e.error));

      const body = await adapter.serve(broken, bus);

      // Framed rather than dropped: an SSE consumer can see this, where a truncated body is
      // indistinguishable from the connection dropping.
      expect(body).toContain('data: {"t":1}\n\n');
      expect(body).toContain('event: error');
      expect(body).toContain('source died');

      expect(seen).toEqual(['stream:open', 'stream:error', 'stream:close']);
      expect((errors[0] as Error).message).toBe('source died');
    });

    it(`${adapter.name}: names the route pattern, not the path that arrived`, async () => {
      const bus = new Bus();
      const names: string[] = [];
      bus.on('stream:open', (e) => names.push(e.name));

      await adapter.serve(clean, bus);
      expect(names).toEqual(['/feed']);
    });
  }

  for (const adapter of ADAPTERS) {
    it(`${adapter.name}: correlates every stream event with the request that opened it`, async () => {
      // The split is deliberate — `request:end` fires when the handler returns, not when the
      // stream it produced finishes, so an hour-long SSE connection and a 2ms reply never share a
      // latency distribution. That only works if the two can be joined, and this is the join key.
      const bus = new Bus();
      const ids = new Set<string | undefined>();
      const traces = new Set<string | undefined>();
      const routes = new Set<string | undefined>();

      for (const name of ['stream:open', 'stream:close'] as const)
        bus.on(name, (e) => {
          ids.add(e.requestId);
          traces.add(e.traceId);
          routes.add(e.route);
        });

      await adapter.serve(clean, bus);

      expect([...ids]).toHaveLength(1);
      expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/); // one id, and it is the request's
      // Bounded by the route table, which is what makes it the field to label a metric on.
      expect([...routes]).toEqual(['/feed']);
      expect([...traces]).toEqual([undefined]); // absent, not invented, when no traceparent arrived
    });
  }

  it('fetch: adopts the gateway s x-request-id rather than opening a second identity', async () => {
    const bus = new Bus();
    const ids: Array<string | undefined> = [];
    bus.on('stream:open', (e) => ids.push(e.requestId));
    bus.on('stream:close', (e) => ids.push(e.requestId));

    await (
      await buildFetch(clean, { bus })(
        new Request('http://x/feed', { headers: { 'x-request-id': 'from-the-gateway', traceparent: 'tp-1' } }),
      )
    ).text();

    expect(ids).toEqual(['from-the-gateway', 'from-the-gateway']);
  });

  it('fetch: closes once when the client cancels mid-stream', async () => {
    // The exit `pipeStream` gets from `res.on('close')` and the ReadableStream gets from `cancel`.
    // Latched, because a cancel can also land after the body has already ended.
    const bus = new Bus();
    const seen = events(bus);
    let released!: () => void;
    const blocked = new Promise<void>((r) => (released = r));

    const endless = route(async function* () {
      yield { t: 1 };
      await blocked;
    });

    const res = await buildFetch(endless, { bus })(new Request('http://x/feed'));
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    released();

    expect(seen).toEqual(['stream:open', 'stream:close']);
  });
});

// GitHub #40. A source idle between events (an SSE feed waiting on something that may never happen)
// has a `next()` that does not settle. Both adapters waited on it after the client left: Node kept
// `pipeStream` running and its closer registered, so shutdown still saw a live stream, and the
// fetch adapter's `cancel` waited on `return()`, which an async generator only runs once its pending
// `next()` settles. The source's own `return()` must not be able to hold that up either.
describe('a client leaving an idle stream', () => {
  const hang = new Promise<never>(() => {});

  /** Yields once, then waits forever; `return()` does whatever `onReturn` does. */
  const idle = (onReturn: () => Promise<IteratorResult<unknown>>): AsyncIterable<unknown> => ({
    [Symbol.asyncIterator]: () => {
      let sent = false;
      return {
        next: () => (sent ? hang : ((sent = true), Promise.resolve({ value: { t: 1 }, done: false }))),
        return: onReturn,
      };
    },
  });

  const SOURCES: Record<string, () => AsyncIterable<unknown>> = {
    'an async generator': async function* () {
      yield { t: 1 };
      await hang;
    },
    'a return() that never settles': () => idle(() => hang),
    'a return() that throws': () =>
      idle(() => {
        throw new Error('return failed');
      }),
  };

  /** Fails with a message instead of the test timing out. */
  const within = <T>(work: Promise<T>, what: string): Promise<T> =>
    Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: hung`)), 1000))]);

  for (const [source, make] of Object.entries(SOURCES))
    for (const compression of [undefined, resolveCompression(true)]) {
      const label = `${source}${compression ? ', compressed' : ''}`;

      it(`node: ${label} — finishes and unregisters on disconnect`, async () => {
        const bus = new Bus();
        const closed = new Promise<void>((r) => bus.on('stream:close', () => r()));
        const streams = new Set<() => void>();
        const server = createHttpServer(route(make), [], bus, undefined, { streams, compression });
        await new Promise<void>((r) => server.listen(0, r));
        const { port } = server.address() as { port: number };
        const ac = new AbortController();

        try {
          const res = await fetch(`http://127.0.0.1:${port}/feed`, {
            signal: ac.signal,
            headers: { 'accept-encoding': 'gzip' },
          });
          await res.body!.getReader().read();
          ac.abort();

          await within(closed, 'stream:close');
          expect(streams.size).toBe(0); // nothing left for a graceful shutdown to wait on
        } finally {
          server.closeAllConnections();
          server.close();
        }
      });

      it(`fetch: ${label} — cancel settles at once`, async () => {
        const bus = new Bus();
        const seen = events(bus);
        const res = await buildFetch(route(make), { bus, compression })(
          new Request('http://x/feed', { headers: { 'accept-encoding': 'gzip' } }),
        );
        const reader = res.body!.getReader();
        await reader.read();

        await within(reader.cancel(), 'cancel()');
        expect(seen).toEqual(['stream:open', 'stream:close']);
      });
    }
});
