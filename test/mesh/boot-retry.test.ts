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

const collect = () => {
  const lines: string[] = [];
  return { lines, logger: { debug() {}, info() {}, warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) } };
};

describe('mesh boot retry', () => {
  it('waits for a teapot that starts late, rather than failing the deploy', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = require('node:net').createServer();
      probe.listen(0, () => {
        const { port: p } = probe.address();
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
      await expect(teacup.fetch(new Request('http://x/api/local/who'))).rejects.toThrow(/mesh/);
      expect(lines.some((l) => l.includes('giving up after'))).toBe(true);
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
      await expect(teacup.fetch(new Request('http://x/api/local/who'))).rejects.toThrow(/mesh/);
      expect(lines.filter((l) => l.includes('of boot budget left'))).toEqual([]);
    } finally {
      await teacup.close();
    }
  }, 15_000);
});
