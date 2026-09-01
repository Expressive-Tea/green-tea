// Framework token names, and the read-only slice of the bus that `@needs` can reach.
//
// Two halves of one decision. The bus is not a graph token — a node that could reach it could also
// `emit`, and an observation channel anything can write to is not one — but `@needs('logger')`
// teaches that framework things *are* graph tokens, so reaching for `@needs('bus')` is the natural
// next move. Documenting that it does not work only reaches a reader; the boot error reaches the
// person writing it. And reserving the names stops a user's own `logger` from quietly becoming the
// one the whole app injects.
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../src/index';
import type { Events } from '../src/index';

@Route('/r')
class Ctl {
  @Get('/x') x() {
    return { ok: true };
  }
}

describe('reserved framework tokens', () => {
  for (const token of ['logger', 'rooms', 'events']) {
    it(`refuses a provider that declares '${token}'`, () => {
      @Provider({ provides: token })
      class Shadow {
        provide() {
          return { [token]: { mine: true } };
        }
      }
      @Module({ mountpoint: '/', providers: [Shadow], controllers: [Ctl] })
      class M {}

      expect(() => createApp({ modules: [M] })).toThrow(
        new RegExp(`'${token}' is reserved by the framework`),
      );
    });
  }

  it("refuses a step that declares 'bus', a name the framework reserves without providing", () => {
    @Step({ provides: 'bus' })
    class Shadow {
      run() {
        return { bus: { mine: true } };
      }
    }
    @Module({ mountpoint: '/', steps: [Shadow], controllers: [Ctl] })
    class M {}

    expect(() => createApp({ modules: [M] })).toThrow(/'bus' is reserved by the framework/);
  });

  it('leaves every other name alone', () => {
    @Provider({ provides: 'buses' })
    class Fine {
      provide() {
        return { buses: 1 };
      }
    }
    @Module({ mountpoint: '/', providers: [Fine], controllers: [Ctl] })
    class M {}

    expect(() => createApp({ modules: [M] })).not.toThrow();
  });
});

describe("@needs('bus')", () => {
  it('fails at boot naming the read-only token and the plugin, not a nearest match', () => {
    @Route('/b')
    class Bad {
      @Get('/x') x(@needs('bus') _bus: unknown) {
        return {};
      }
    }
    @Module({ mountpoint: '/', controllers: [Bad] })
    class M {}

    expect(() => createApp({ modules: [M] })).toThrow(/the Bus is not a graph token/);
    expect(() => createApp({ modules: [M] })).toThrow(/@needs\('events'\)/);
    expect(() => createApp({ modules: [M] })).toThrow(/plugin/);
  });
});

describe("@needs('events')", () => {
  it('hands over on() and nothing else — no emit to forge events with', async () => {
    let injected: Events | undefined;

    @Route('/e')
    class Observer {
      @Get('/x') x(@needs('events') events: Events) {
        injected = events;
        return { ok: true };
      }
    }
    @Module({ mountpoint: '/', controllers: [Observer] })
    class M {}

    const app = createApp({ modules: [M] });
    await app.fetch(new Request('http://x/e/x'));

    expect(typeof injected?.on).toBe('function');
    expect(Object.keys(injected!)).toEqual(['on']);
    expect((injected as unknown as { emit?: unknown }).emit).toBeUndefined();
  });

  it('subscribes to the same bus the framework emits on, and hands back an unsubscribe', async () => {
    const seen: string[] = [];

    @Provider({ provides: 'watcher', needs: ['events'] })
    class Watcher {
      #off?: () => void;
      provide(ctx: { events: Events }) {
        this.#off = ctx.events.on('request:end', (e) => seen.push(e.route ?? ''));
        return { watcher: true };
      }
      dispose() {
        this.#off?.();
      }
    }
    @Route('/e')
    class Observed {
      @Get('/y') y(@needs('watcher') _w: unknown) {
        return { ok: true };
      }
    }
    @Module({ mountpoint: '/', providers: [Watcher], controllers: [Observed] })
    class M {}

    const app = createApp({ modules: [M] });
    await app.fetch(new Request('http://x/e/y'));

    expect(seen).toEqual(['/e/y']);

    // dispose() releases it, which is the half a plugin gets for free with onShutdown. Asserted by
    // emitting after close and watching nothing arrive — clearing the array and finding it empty
    // would prove only that clearing works.
    await app.close();
    seen.length = 0;
    app.bus.emit('request:end', { name: 'after close', route: '/after' });
    expect(seen).toEqual([]);
  });
});
