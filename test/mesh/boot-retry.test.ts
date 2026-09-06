import * as net from 'node:net';
import { describe, it, expect } from 'vitest';
import { createApp, Step, Route, Get, Module, needs } from '../../src/index';

@Step({ provides: 'auth', needs: [], export: true })
class Auth {
  run() {
    return { auth: { ok: true } };
  }
}
@Module({ mountpoint: '/api', steps: [Auth] })
class TeapotModule {}

@Route('/local')
class LocalCtl {
  @Get('/who')
  who(@needs('auth') auth: any) {
    return { auth };
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

@Route('/ping')
class PingCtl {
  @Get('/')
  ping() {
    return { ok: true };
  }
}
@Module({ mountpoint: '/api', controllers: [PingCtl] })
class LocalOnlyModule {}

// A step (not a route handler) needing 'auth' so the missing-dependency check that fires is
// `topoSort`'s — the one that gets the "these teapots did not connect" note — rather than the
// route-level `assertNeedsSatisfiable` check, which is untouched by this change.
@Step({ provides: 'profile', needs: ['auth'] })
class NeedsAuth {
  run() {
    return { profile: {} };
  }
}
@Module({ mountpoint: '/api', steps: [NeedsAuth] })
class NeedsAuthModule {}

/** A free port, taken by opening and immediately closing a server on port 0. */
const freePort = async (): Promise<number> =>
  new Promise<number>((resolve) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const collect = () => {
  const lines: string[] = [];
  return { lines, logger: { debug() {}, info() {}, warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } };
};

describe('mesh boot retry', () => {
  it('waits for a teapot that starts late, rather than failing the deploy', async () => {
    const port = await freePort();
    const { lines, logger } = collect();

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      logger,
      mesh: {
        teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: 'good' }],
        timeoutMs: 500,
        bootTimeoutMs: 4000,
      },
    });

    // the teapot arrives *after* the teacup has already started trying
    const pending = teacup.fetch(new Request('http://x/api/local/who'));
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: 'good' } });
    await new Promise((r) => setTimeout(r, 300));
    const server = await teapot.listen(port);

    try {
      const res = await pending;
      expect(res.status).toBe(200);
      expect(lines.some((l) => l.includes('of boot budget left'))).toBe(true);
    } finally {
      await teacup.close();
      await teapot.close();
      server.close();
    }
  }, 15_000);

  it('still fails the boot once the budget is spent — a needed provider is not optional', async () => {
    const { lines, logger } = collect();
    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      logger,
      mesh: {
        teapots: [{ url: 'ws://127.0.0.1:1/__mesh__/control', secret: 'good' }],
        timeoutMs: 200,
        bootTimeoutMs: 600,
      },
    });

    try {
      // exhausting the budget is no longer fatal by itself (that's the point of this change) —
      // the boot still fails here because `who` needs 'auth' and nothing local provides it. The
      // exact message, not a bare /mesh/ match (which would also match this message's own
      // "(local or connected mesh)" wording for an unrelated reason).
      await expect(teacup.fetch(new Request('http://x/api/local/who'))).rejects.toThrow(
        /needs 'auth' but nothing \(local or connected mesh\) provides it[\s\S]*did not connect/i,
      );
      expect(lines.some((l) => l.includes('starting without it'))).toBe(true);
    } finally {
      await teacup.close();
    }
  }, 15_000);

  it('names the absent teapot when a route handler needs its token directly', async () => {
    // `who` needs 'auth' via `@needs`, not through a `@Step` — this goes through
    // `assertNeedsSatisfiable`, a different check than `topoSort`'s, and must carry the same note.
    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: {
        teapots: [{ url: 'ws://127.0.0.1:9/x', secret: 's' }],
        secret: 's',
        bootTimeoutMs: 300,
      },
    });

    try {
      await expect(teacup.ready()).rejects.toThrow(
        /needs 'auth' but nothing \(local or connected mesh\) provides it[\s\S]*did not connect.*127\.0\.0\.1:9/i,
      );
    } finally {
      await teacup.close();
    }
  }, 15_000);

  it('does not retry a wrong secret — the teapot refused, and it will refuse again', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: 'good' } });
    const server = await teapot.listen(0);
    const port = (server.address() as { port: number }).port;
    const { lines, logger } = collect();

    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      logger,
      mesh: {
        teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: 'WRONG' }],
        timeoutMs: 500,
        bootTimeoutMs: 30_000,
      },
    });

    try {
      const started = Date.now();
      await expect(teacup.fetch(new Request('http://x/api/local/who'))).rejects.toThrow(/mesh/);
      // with a 30s budget, retrying would have taken 30s to reach the same error
      expect(Date.now() - started).toBeLessThan(3000);
      expect(lines.some((l) => l.includes('refused this peer'))).toBe(true);
      expect(lines.filter((l) => l.includes('of boot budget left'))).toEqual([]);
    } finally {
      await teacup.close();
      await teapot.close();
      server.close();
    }
  }, 40_000);

  it('boots when a teapot is unreachable and nothing local needs it', async () => {
    const teacup = createApp({
      modules: [LocalOnlyModule], // declares no needs on a remote token
      experimental: true,
      mesh: {
        teapots: [{ url: 'ws://127.0.0.1:9/x', secret: 's' }],
        secret: 's',
        bootTimeoutMs: 300,
      },
    });

    try {
      await expect(teacup.ready()).resolves.toBeUndefined();
      const res = await teacup.fetch(new Request('http://x/api/ping'));
      expect(res.status).toBe(200);
    } finally {
      await teacup.close();
    }
  }, 15_000);

  it('names the teapot in the log a later 404 points back to', async () => {
    // A route the absent teapot would have exported 404s, because nothing was ever registered for a
    // manifest that never arrived. That is the right status — you cannot serve what was never
    // declared — but a bare 404 is indistinguishable from a typo in the path. The boot log is the
    // only place the two are told apart, so it has to name *which* teapot and say that no manifest
    // was exchanged. The unreachable error itself is a socket error and does not reliably carry
    // the url, so the url is passed in rather than scraped out of the message.
    const { lines, logger } = collect();
    const teacup = createApp({
      modules: [LocalOnlyModule],
      experimental: true,
      logger,
      mesh: {
        teapots: [{ url: 'ws://127.0.0.1:9/x', secret: 's' }],
        secret: 's',
        bootTimeoutMs: 300,
      },
    });

    try {
      await teacup.ready();
      const gaveUp = lines.find((line) => line.includes('starting without it'));

      expect(gaveUp).toBeDefined();
      expect(gaveUp).toContain('ws://127.0.0.1:9/x');
      expect(gaveUp).toMatch(/no manifest was ever exchanged/i);
      expect(gaveUp).toMatch(/404/);

      // and the retry lines on the way there name it too, so a deploy tailing logs sees which one
      expect(lines.some((line) => /retrying/.test(line) && line.includes('ws://127.0.0.1:9/x'))).toBe(true);
    } finally {
      await teacup.close();
    }
  }, 15_000);

  it('still fails the boot when a local step needs a token the absent teapot owned', async () => {
    const teacup = createApp({
      modules: [NeedsAuthModule], // a step with needs: ['auth']
      experimental: true,
      mesh: {
        teapots: [{ url: 'ws://127.0.0.1:9/x', secret: 's' }],
        secret: 's',
        bootTimeoutMs: 300,
      },
    });

    try {
      await expect(teacup.ready()).rejects.toThrow(/missing dependency: auth[\s\S]*did not connect/i);
    } finally {
      await teacup.close();
    }
  }, 15_000);

  it('leaves no reconnect supervisor behind when the boot never reached its teapot', async () => {
    // Every failed boot attempt used to leak one. `openSession`'s abort listener runs `onEnd` even
    // when the connect promise *rejects*, and `onEnd` schedules a retry — but a link that never
    // resolved was never handed to anyone, so it was never pushed to `meshLinks` and `close()`
    // could not reach it. Before the app was allowed to start without a teapot the process died
    // with them; now it survives, and each one holds a socket open forever.
    const port = await freePort();
    const { logger } = collect();
    const teacupConnects: string[] = [];

    const teacup = createApp({
      modules: [LocalOnlyModule], // nothing local needs the teapot, so the boot is allowed to finish
      experimental: true,
      logger,
      mesh: {
        teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: 'good' }],
        timeoutMs: 200,
        bootTimeoutMs: 600, // several attempts, each of which used to leave a supervisor running
        reconnect: { initialDelayMs: 20, maxDelayMs: 60 }, // a leak would hammer, not trickle
      },
    });
    teacup.bus.on('mesh:connect', (event) => teacupConnects.push(event.name));

    await teacup.ready();
    await teacup.close();

    // Only now does the teapot arrive. Nothing in this process holds a link to it.
    const teapotConnects: string[] = [];
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: 'good' } });
    teapot.bus.on('mesh:connect', (event) => teapotConnects.push(event.name));
    const server = await teapot.listen(port);

    try {
      await new Promise((r) => setTimeout(r, 500)); // ~8 retries at the bounds above

      expect(teacupConnects).toEqual([]);
      // the teapot side, so this fails on a socket that opened even if the teacup never adopted it
      expect(teapotConnects).toEqual([]);
    } finally {
      await teapot.close();
      server.close();
    }
  }, 15_000);

  it('bootTimeoutMs: 0 makes one attempt, as before', async () => {
    const { lines, logger } = collect();
    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      logger,
      mesh: {
        teapots: [{ url: 'ws://127.0.0.1:1/__mesh__/control', secret: 'good' }],
        timeoutMs: 200,
        bootTimeoutMs: 0,
      },
    });

    try {
      await expect(teacup.fetch(new Request('http://x/api/local/who'))).rejects.toThrow(
        /needs 'auth' but nothing \(local or connected mesh\) provides it[\s\S]*did not connect/i,
      );
      expect(lines.filter((l) => l.includes('of boot budget left'))).toEqual([]);
    } finally {
      await teacup.close();
    }
  }, 15_000);
});
