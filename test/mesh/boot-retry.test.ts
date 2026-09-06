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

const collect = () => {
  const lines: string[] = [];
  return { lines, logger: { debug() {}, info() {}, warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } };
};

describe('mesh boot retry', () => {
  it('waits for a teapot that starts late, rather than failing the deploy', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, () => {
        const { port: p } = probe.address() as { port: number };
        probe.close(() => resolve(p));
      });
    });
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
