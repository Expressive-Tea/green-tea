import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Provider, Module, Route, Get } from '../src/metadata';
import { createApp } from '../src/app';
import type { Plugin } from '../src/plugin';
import type { Logger } from '../src/logger';

const silentLogger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

@Route('/')
class Ctl {
  @Get('/ping') ping() {
    return { ok: true };
  }
}

describe('shutdown teardown', () => {
  it('awaits a plugin onShutdown before close() resolves', async () => {
    const order: string[] = [];
    const plugin: Plugin = (api) => {
      api.onShutdown(async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('plugin torn down');
      });
    };

    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], plugins: [plugin], logger: silentLogger() });
    await app.listen(0);
    await app.close();
    order.push('close returned');

    expect(order).toEqual(['plugin torn down', 'close returned']);
  });

  it('runs a hook onShutdown without the app declaring a plugin', async () => {
    const seen: string[] = [];
    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    const app = createApp({
      modules: [M],
      hooks: [{ onShutdown: () => void seen.push('hook') }],
      logger: silentLogger(),
    });
    await app.listen(0);
    await app.close();

    expect(seen).toEqual(['hook']);
  });

  it('calls a provider dispose(), and skips a provider without one', async () => {
    const closed: string[] = [];

    @Provider({ provides: 'db' })
    class Db {
      provide() {
        return { db: {} };
      }
      async dispose() {
        closed.push('db');
      }
    }
    @Provider({ provides: 'plain' })
    class Plain {
      provide() {
        return { plain: {} };
      }
    }

    @Module({ mountpoint: '/', providers: [Db, Plain], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], logger: silentLogger() });
    await app.listen(0);
    await app.close();

    expect(closed).toEqual(['db']);
  });

  // D5, and the reason dispose() is registered as a provider boots rather than as it is collected.
  it('tears a dependant down before the dependency it needs', async () => {
    const closed: string[] = [];

    @Provider({ provides: 'db' })
    class Db {
      provide() {
        return { db: {} };
      }
      dispose() {
        closed.push('db');
      }
    }
    @Provider({ provides: 'cache', needs: ['db'] })
    class Cache {
      provide() {
        return { cache: {} };
      }
      dispose() {
        closed.push('cache');
      }
    }

    // Declared dependency-last on purpose: the order must come from the graph, not the array.
    @Module({ mountpoint: '/', providers: [Cache, Db], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], logger: silentLogger() });
    await app.listen(0);
    await app.close();

    expect(closed).toEqual(['cache', 'db']);
  });

  it('does not dispose a provider that failed to boot', async () => {
    const closed: string[] = [];

    @Provider({ provides: 'broken', optional: true })
    class Broken {
      provide(): unknown {
        throw new Error('cannot connect');
      }
      dispose() {
        closed.push('broken');
      }
    }

    @Module({ mountpoint: '/', providers: [Broken], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], logger: silentLogger() });
    await app.listen(0);
    await app.close();

    expect(closed).toEqual([]);
  });

  it('logs a failing teardown, runs the rest, and still resolves', async () => {
    const logger = silentLogger();
    const closed: string[] = [];
    const plugin: Plugin = (api) => {
      api.onShutdown(() => {
        throw new Error('teardown boom');
      });
      api.onShutdown(() => void closed.push('survivor'));
    };

    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], plugins: [plugin], logger });
    await app.listen(0);
    await expect(app.close()).resolves.toBeUndefined();

    expect(closed).toEqual(['survivor']);
    expect(vi.mocked(logger.warn).mock.calls.some((c) => /teardown boom/.test(c[0]))).toBe(true);
  });

  it('does not let a hanging teardown push close() past its deadline', async () => {
    const plugin: Plugin = (api) => {
      api.onShutdown(() => new Promise<void>(() => {})); // never settles
    };

    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], plugins: [plugin], logger: silentLogger() });
    await app.listen(0);

    const startedAt = Date.now();
    await app.close({ timeoutMs: 300 });
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('rejects a reservation larger than the budget it comes out of', () => {
    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    expect(() => createApp({ modules: [M], shutdownTimeoutMs: 1000, teardownTimeoutMs: 2000 })).toThrow(
      /cannot exceed shutdownTimeoutMs/,
    );
  });

  it('tears down an app that was never listen()ed, since its providers still booted', async () => {
    const closed: string[] = [];

    @Provider({ provides: 'db' })
    class Db {
      provide() {
        return { db: {} };
      }
      dispose() {
        closed.push('db');
      }
    }

    @Module({ mountpoint: '/', providers: [Db], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], logger: silentLogger() });
    await app.fetch(new Request('http://x/ping')); // boots providers, no server
    await app.close();

    expect(closed).toEqual(['db']);
  });

  it('drains only once when close() is called twice', async () => {
    let runs = 0;
    const plugin: Plugin = (api) => {
      api.onShutdown(() => void runs++);
    };

    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M], plugins: [plugin], logger: silentLogger() });
    await app.listen(0);
    await app.close();
    await app.close();

    expect(runs).toBe(1);
  });
});
