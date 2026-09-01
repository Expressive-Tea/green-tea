// The `request:start` / `request:end` pairing, asserted across every terminal path there is.
//
// The guarantee held by accident until `maxConcurrentRequests` arrived: `request:start` had a
// single emitter, so nothing could break it. It has more than one now, and a guarantee upheld by
// there being only one place to get it wrong is not a guarantee — it is a coincidence with good
// timing. This file is what makes the next terminal path fail loudly instead of quietly.
//
// Adding a response shape? Add a row. That is the whole maintenance contract.
import { describe, expect, it } from 'vitest';
import { Bus } from '../src/bus';
import { createHttpServer } from '../src/http';
import { buildFetch } from '../src/http/web';

interface Seen {
  starts: string[];
  ends: Array<{ requestId?: string; status?: number }>;
}

function watch(bus: Bus): Seen {
  const seen: Seen = { starts: [], ends: [] };
  bus.on('request:start', (e) => seen.starts.push(e.requestId ?? ''));
  bus.on('request:end', (e) => seen.ends.push({ requestId: e.requestId, status: e.status }));
  return seen;
}

const ok = async () => ({ status: 200, headers: {}, body: 'ok' });
const boom = async () => {
  throw new Error('kaboom');
};

/** Every shape of request the framework can answer, and how to provoke it. */
const SHAPES: Array<{
  name: string;
  status: number;
  routes: Parameters<typeof buildFetch>[0];
  opts?: Parameters<typeof buildFetch>[1];
  request: () => Request;
}> = [
  {
    name: 'matched handler',
    status: 200,
    routes: [{ method: 'GET', pattern: '/ok', transport: 'buffer', handler: ok }],
    request: () => new Request('http://x/ok'),
  },
  {
    name: 'unmatched route',
    status: 404,
    routes: [{ method: 'GET', pattern: '/ok', transport: 'buffer', handler: ok }],
    request: () => new Request('http://x/nope'),
  },
  {
    name: 'handler throws',
    status: 500,
    routes: [{ method: 'GET', pattern: '/boom', transport: 'buffer', handler: boom }],
    request: () => new Request('http://x/boom'),
  },
  {
    name: 'body over maxBodyBytes',
    status: 413,
    routes: [{ method: 'POST', pattern: '/echo', transport: 'buffer', handler: ok }],
    opts: { limits: { maxBodyBytes: 8 } },
    request: () => new Request('http://x/echo', { method: 'POST', body: 'x'.repeat(500) }),
  },
  {
    name: 'CORS preflight',
    status: 204,
    routes: [{ method: 'GET', pattern: '/ok', transport: 'buffer', handler: ok }],
    opts: { cors: { origins: '*' } },
    request: () =>
      new Request('http://x/ok', {
        method: 'OPTIONS',
        headers: { origin: 'https://a.com', 'access-control-request-method': 'GET' },
      }),
  },
];

describe('every terminal path emits request:start before request:end', () => {
  for (const shape of SHAPES) {
    it(`${shape.name} → ${shape.status}`, async () => {
      const bus = new Bus();
      const seen = watch(bus);
      const fetchHandler = buildFetch(shape.routes, { ...shape.opts, bus });

      const res = await fetchHandler(shape.request());

      expect(res.status).toBe(shape.status);
      expect(seen.starts).toHaveLength(1);
      expect(seen.ends).toHaveLength(1);
      // Same request, not two that happened to arrive together — the id is what a consumer keys on.
      expect(seen.ends[0].requestId).toBe(seen.starts[0]);
    });
  }

  // The path that broke the pairing, and the reason this file exists. It never reaches `handle()`,
  // so the emitter every row above goes through never sees it.
  it('shed over maxConcurrentRequests → 503', async () => {
    const bus = new Bus();
    const seen = watch(bus);
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r));

    const fetchHandler = buildFetch(
      [{ method: 'GET', pattern: '/slow', transport: 'buffer', handler: async () => (await blocked, ok()) }],
      { bus, limits: { maxConcurrentRequests: 1 } },
    );

    const first = fetchHandler(new Request('http://x/slow'));
    const shed = await fetchHandler(new Request('http://x/slow'));

    expect(shed.status).toBe(503);
    release();
    await first;

    const shedPair = seen.ends.find((e) => e.status === 503)!;
    expect(shedPair).toBeDefined();
    expect(seen.starts).toContain(shedPair.requestId);
  });

  // The Node adapter sheds through its own code path, so passing on `buildFetch` proves nothing
  // about it — the two were separate emitters before they shared one.
  it('shed over maxConcurrentRequests → 503, on the Node adapter', async () => {
    const bus = new Bus();
    const seen = watch(bus);
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((r) => (release = r));
    const firstStarted = new Promise<void>((r) => (started = r));

    const server = createHttpServer(
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
      [],
      bus,
      undefined,
      { limits: { maxConcurrentRequests: 1 } },
    );
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/slow`;

    const first = fetch(url);
    await firstStarted;
    const shed = await fetch(url);

    expect(shed.status).toBe(503);
    release();
    await first;

    const shedPair = seen.ends.find((e) => e.status === 503)!;
    expect(shedPair).toBeDefined();
    expect(seen.starts).toContain(shedPair.requestId);
    server.close();
  });

  // The invariant stated as a count rather than per row. Scoped to the enumerated shapes on
  // purpose — the two shed paths have their own tests above, because they are the ones that need
  // a blocked handler to provoke and the ones that broke it in the first place.
  it('leaves no enumerated shape with an end whose start is missing', async () => {
    const bus = new Bus();
    const seen = watch(bus);
    const fetchHandler = buildFetch(
      [{ method: 'GET', pattern: '/ok', transport: 'buffer', handler: ok }],
      { bus, cors: { origins: '*' } },
    );

    for (const shape of SHAPES) {
      const h = buildFetch(shape.routes, { ...shape.opts, bus });
      await h(shape.request());
    }
    await fetchHandler(new Request('http://x/ok'));

    expect(seen.ends).not.toHaveLength(0);
    for (const end of seen.ends) expect(seen.starts).toContain(end.requestId);
    expect(seen.starts).toHaveLength(seen.ends.length);
  });
});
