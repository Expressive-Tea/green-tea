// Independent providers boot concurrently; dependent ones still wait.
//
// The graph already proved which providers cannot constrain each other — that is what the topo
// sort *is*. Booting them one at a time charged every app the sum of its providers' latencies
// instead of its longest chain, for no ordering anyone declared.
//
// Timing is asserted structurally rather than by clock: "all three entered before any left" is
// the same claim as "they overlapped" and does not get flaky on a loaded CI box.
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Get, Module, Provider, Route, type Ctor } from '../src/metadata';
import { createApp } from '../src/app';
import type { Logger } from '../src/logger';

const silentLogger = (): Logger => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

@Route('/')
class Ctl {
  @Get('/ping') ping() {
    return { ok: true };
  }
}

/** Boots the app by serving one request — providers are lazy until something is actually served. */
async function boot(module: Ctor, logger = silentLogger()): Promise<void> {
  const app = createApp({ modules: [module], logger });
  await app.fetch(new Request('http://x/ping'));
  await app.close();
}

describe('provider boot concurrency', () => {
  it('overlaps providers that do not depend on each other', async () => {
    const log: string[] = [];

    const independent = (name: string): Ctor => {
      @Provider({ provides: name })
      class P {
        async provide() {
          log.push(`${name}:in`);
          await sleep(10);
          log.push(`${name}:out`);
          return { [name]: name };
        }
      }
      return P;
    };

    @Module({ mountpoint: '/', controllers: [Ctl], providers: [independent('a'), independent('b'), independent('c')] })
    class M {}
    await boot(M);

    // Serial boot gives a:in a:out b:in … — every entry preceded by the previous exit.
    expect(log.slice(0, 3)).toEqual(['a:in', 'b:in', 'c:in']);
    expect(log).toHaveLength(6);
  });

  it('still waits for a provider its dependant needs', async () => {
    const log: string[] = [];

    @Provider({ provides: 'base' })
    class Base {
      async provide() {
        log.push('base:in');
        await sleep(10);
        log.push('base:out');
        return { base: 1 };
      }
    }

    @Provider({ provides: 'derived', needs: ['base'] })
    class Derived {
      provide(ctx: { base: number }) {
        log.push('derived:in');
        return { derived: ctx.base + 1 };
      }
    }

    // Declared out of order on purpose: the wait is the graph's doing, not the array's.
    @Module({ mountpoint: '/', controllers: [Ctl], providers: [Derived, Base] })
    class M {}
    await boot(M);

    expect(log).toEqual(['base:in', 'base:out', 'derived:in']);
  });

  it('gives a dependant every value from its level, not just the one that finished first', async () => {
    @Provider({ provides: 'slow' })
    class Slow {
      async provide() {
        await sleep(15);
        return { slow: 'slow' };
      }
    }

    @Provider({ provides: 'fast' })
    class Fast {
      provide() {
        return { fast: 'fast' };
      }
    }

    let seen: Record<string, unknown> = {};
    @Provider({ provides: 'joined', needs: ['slow', 'fast'] })
    class Joined {
      provide(ctx: Record<string, unknown>) {
        seen = { slow: ctx.slow, fast: ctx.fast };
        return { joined: true };
      }
    }

    @Module({ mountpoint: '/', controllers: [Ctl], providers: [Slow, Fast, Joined] })
    class M {}
    await boot(M);

    expect(seen).toEqual({ slow: 'slow', fast: 'fast' });
  });

  it('tears down in reverse boot order even though boot is concurrent', async () => {
    const disposed: string[] = [];

    const independent = (name: string, delay: number): Ctor => {
      @Provider({ provides: name })
      class P {
        async provide() {
          await sleep(delay);
          return { [name]: name };
        }
        dispose() {
          disposed.push(name);
        }
      }
      return P;
    };

    // `c` finishes first and `a` last — completion order is the reverse of declaration order, so a
    // teardown registered as each one lands would come out in a different order than this.
    @Module({
      mountpoint: '/',
      controllers: [Ctl],
      providers: [independent('a', 20), independent('b', 10), independent('c', 1)],
    })
    class M {}
    await boot(M);

    expect(disposed).toEqual(['c', 'b', 'a']);
  });

  it('fails the boot on a required provider, and still registers its siblings for teardown', async () => {
    const disposed: string[] = [];

    @Provider({ provides: 'ok' })
    class Ok {
      async provide() {
        await sleep(10); // still in flight when its sibling rejects
        return { ok: true };
      }
      dispose() {
        disposed.push('ok');
      }
    }

    @Provider({ provides: 'broken' })
    class Broken {
      provide(): never {
        throw new Error('no pool');
      }
    }

    @Module({ mountpoint: '/', controllers: [Ctl], providers: [Ok, Broken] })
    class M {}
    const app = createApp({ modules: [M], logger: silentLogger() });

    await expect(app.fetch(new Request('http://x/ping'))).rejects.toThrow("provider 'broken' failed: no pool");
    // The sibling booted — it was already in flight — so whatever it opened has to be closeable.
    await app.close();
    expect(disposed).toEqual(['ok']);
  });

  it('degrades an optional provider without taking its level down', async () => {
    const logger = silentLogger();

    @Provider({ provides: 'flaky', optional: true })
    class Flaky {
      provide(): never {
        throw new Error('nope');
      }
    }

    @Provider({ provides: 'solid' })
    class Solid {
      provide() {
        return { solid: true };
      }
    }

    @Module({ mountpoint: '/', controllers: [Ctl], providers: [Flaky, Solid] })
    class M {}
    const app = createApp({ modules: [M], logger });
    await app.fetch(new Request('http://x/ping'));

    expect(app.degraded()).toEqual(['flaky']);
    await app.close();
  });
});
