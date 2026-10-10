import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { Bus } from '../src/bus';
import { createHttpServer } from '../src/http';
import type { HttpOptions, RouteDef } from '../src/http/types';
import type { Logger } from '../src/logger';

// #108: `http.createServer` ignores the promise its listener returns, so a rejection inside the
// request listener used to be an `unhandledRejection` — fatal under Node's default mode. Every test
// here goes through a real socket, because the boundary under test is the Node listener itself.

interface Reply {
  status?: number;
  headers?: http.IncomingHttpHeaders;
  body?: string;
  /** Set when the connection ended without a complete response. */
  error?: string;
}

/** A GET on a fresh connection (`agent: false`), bounded so a hung listener fails fast instead of at the 30 s request timeout. */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve) => {
    const reply: Reply = {};
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      reply.status = res.statusCode;
      reply.headers = res.headers;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ ...reply, body }));
      res.on('error', (err) => resolve({ ...reply, body, error: err.message }));
      res.on('aborted', () => resolve({ ...reply, body, error: 'aborted' }));
    });
    req.setTimeout(1_000, () => req.destroy(new Error('client timeout')));
    req.on('error', (err) => resolve({ ...reply, error: err.message }));
    req.end();
  });
}

function spyLogger(): Logger & { error: Mock<(...args: unknown[]) => void> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const ok: RouteDef = {
  method: 'GET',
  pattern: '/ok',
  transport: 'buffer',
  handler: async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' }),
};

const servers: http.Server[] = [];

async function start(routes: RouteDef[], opts: HttpOptions = {}, bus?: Bus): Promise<number> {
  const server = createHttpServer([ok, ...routes], [], bus, undefined, opts);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

/** T10: after every injected failure, a normal request on a fresh connection still succeeds. */
async function expectServerStillServes(port: number): Promise<void> {
  const next = await get(port, '/ok');
  expect(next.status).toBe(200);
  expect(next.body).toBe('ok');
}

const settle = () => new Promise((r) => setTimeout(r, 20));

let unhandled: Mock<(...args: unknown[]) => void>;
let uncaught: Mock<(...args: unknown[]) => void>;

beforeEach(() => {
  unhandled = vi.fn();
  uncaught = vi.fn();
  process.on('unhandledRejection', unhandled);
  process.on('uncaughtException', uncaught);
});

afterEach(async () => {
  await settle();
  process.off('unhandledRejection', unhandled);
  process.off('uncaughtException', uncaught);

  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }

  expect(unhandled).not.toHaveBeenCalled();
  expect(uncaught).not.toHaveBeenCalled();
});

const rejectingStatic = (reason: unknown) => async () => {
  throw reason;
};

describe('Node request-listener boundary (#108)', () => {
  it('T1: a rejected request operation while writable answers a minimal 500 and closes', async () => {
    const logger = spyLogger();
    const port = await start([], { static: rejectingStatic(new Error('boom')), logger });

    const res = await get(port, '/missing');
    expect(res.status).toBe(500);
    expect(res.headers?.connection).toBe('close');
    expect(res.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(res.body!)).toEqual({ error: 'Internal Server Error' });
    // The security headers still land: the minimal path writes through the patched writeHead.
    expect(res.headers?.['x-content-type-options']).toBe('nosniff');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('request listener failed', { err: 'boom' });

    await expectServerStillServes(port);
  });

  it.each([['boom'], [undefined]])('T2: a non-Error rejection (%s) answers 500 and logs String(err)', async (reason) => {
    const logger = spyLogger();
    const port = await start([], { static: rejectingStatic(reason), logger });

    const res = await get(port, '/missing');
    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith('request listener failed', { err: String(reason) });

    await expectServerStillServes(port);
  });

  // Deviation from the card: `originAllowed` already guards a throwing predicate and denies the origin
  // (src/security.ts), so this never reaches the listener boundary. Kept as a regression test.
  it('T3: a throwing cors.origins predicate denies the origin and serves the request', async () => {
    const logger = spyLogger();
    const port = await start([], {
      logger,
      cors: {
        origins: () => {
          throw new Error('allowlist down');
        },
      },
    });

    const res = await get(port, '/ok', { origin: 'https://a.example' });
    expect(res.status).toBe(200);
    expect(res.headers?.['access-control-allow-origin']).toBeUndefined();

    await expectServerStillServes(port);
  });

  it('T4: an invalid handler header value answers 500 through the minimal path', async () => {
    const logger = spyLogger();
    const port = await start(
      [
        {
          method: 'GET',
          pattern: '/bad-header',
          transport: 'buffer',
          handler: async () => ({ status: 200, headers: { 'x-bad': 'a\nb' }, body: 'nope' }),
        },
      ],
      { logger },
    );

    const res = await get(port, '/bad-header');
    expect(res.status).toBe(500);
    expect(res.headers?.connection).toBe('close');
    expect(res.headers?.['x-bad']).toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);

    await expectServerStillServes(port);
  });

  // The card's BigInt injection is caught inside `pipeStream`'s loop and becomes an error frame, so it
  // never reaches the boundary; kept as a regression test. The second case fails after the 200 headers
  // are flushed but before that loop, which is the "output already started" path.
  it('T5a: a stream encoder failure on the first frame ends the stream with an error frame', async () => {
    const port = await start([
      {
        method: 'GET',
        pattern: '/big',
        transport: 'ndjson',
        handler: async () => ({
          stream: (async function* () {
            yield { n: BigInt(1) };
          })(),
        }),
      },
    ]);

    const res = await get(port, '/big');
    expect(res.status).toBe(200);
    expect(res.body).toContain('"error"');

    await expectServerStillServes(port);
  });

  it('T5b: a failure after the 200 headers were sent destroys the connection and is logged', async () => {
    const logger = spyLogger();
    const port = await start(
      [
        {
          method: 'GET',
          pattern: '/broken-stream',
          transport: 'ndjson',
          handler: async () => ({
            stream: {
              [Symbol.asyncIterator]() {
                throw new Error('iterator failed');
              },
            },
          }),
        },
      ],
      { logger },
    );

    const res = await get(port, '/broken-stream');
    expect(res.status).toBe(200);
    expect(res.error).toBeDefined();
    expect(logger.error).toHaveBeenCalledWith('request listener failed', { err: 'iterator failed' });

    await expectServerStillServes(port);
  });

  it('T6: a throwing onError still sends the built-in 404', async () => {
    const logger = spyLogger();
    const port = await start([], {
      logger,
      onError: () => {
        throw new Error('renderer broke');
      },
    });

    const res = await get(port, '/missing');
    expect(res.status).toBe(404);

    await expectServerStillServes(port);
  });

  it('T7: a throwing request:start observer does not alter the response', async () => {
    const bus = new Bus();
    bus.on('request:start', () => {
      throw new Error('observer broke');
    });
    const port = await start([], { bus }, bus);

    await expectServerStillServes(port);
    await expectServerStillServes(port);
  });

  it('T8: a client abort racing a rejection leaves no unhandled rejection and no write after close', async () => {
    const logger = spyLogger();
    let rejected!: () => void;
    const done = new Promise<void>((r) => (rejected = r));
    const port = await start([], {
      logger,
      static: async () => {
        await new Promise((r) => setTimeout(r, 50));
        rejected();
        throw new Error('late');
      },
    });

    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET /missing HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((r) => setTimeout(r, 10));
    socket.destroy();
    await done;
    await settle();

    expect(logger.error).toHaveBeenCalledWith('request listener failed', { err: 'late' });
    await expectServerStillServes(port);
  });

  it('T9: a rejection releases its maxConcurrentRequests slot', async () => {
    const port = await start(
      [],
      { static: rejectingStatic(new Error('boom')), limits: { maxConcurrentRequests: 1 }, logger: spyLogger() },
    );

    expect((await get(port, '/missing')).status).toBe(500);
    await expectServerStillServes(port);
    await expectServerStillServes(port);
  });
});
