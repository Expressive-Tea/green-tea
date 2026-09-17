// The three legitimate ways to reach the bus, exercised together in one app.
//
// `bus` became a reserved name and the `Bus` itself is still not a graph token, so this file's job
// is to prove that what closed is only the wrong door: observation from outside, from a plugin and
// from inside the graph all still work, and only `emit` stays where it was.
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { createApp, Route, Get, Module, needs } from '../src/index';
import type { Events, Plugin } from '../src/index';

@Route('/b')
class Ctl {
  @Get('/x') x(@needs('events') events: Events) {
    // Reaching it per request is allowed; *subscribing* per request is the thing the docs warn
    // about, and nothing here does that.
    return { hasOn: typeof events.on === 'function' };
  }
}

describe('reaching the bus', () => {
  it('works from outside, from a plugin and from the graph, all at once', async () => {
    const fromOutside: string[] = [];
    const fromPlugin: string[] = [];

    const observer: Plugin = {
      name: 'bus-observer',
      mount(api) {
        api.bus.on('request:end', (e) => fromPlugin.push(e.route ?? ''));
      },
    };

    @Module({ mountpoint: '/', controllers: [Ctl] })
    class M {}

    const app = createApp({ modules: [M], plugins: [observer] });
    // 1. from outside: the public `app.bus`, which keeps `emit` too.
    app.bus.on('request:end', (e) => fromOutside.push(e.route ?? ''));

    // 3. from the graph: the handler receives `events` and reports its shape.
    const res = await app.fetch(new Request('http://x/b/x'));

    expect(await res.json()).toEqual({ hasOn: true });
    expect(fromOutside).toEqual(['/b/x']);
    expect(fromPlugin).toEqual(['/b/x']);

    await app.close();
  });

  it('keeps emit outside the graph and outside plugins, and only there', async () => {
    let injected: Events | undefined;
    const seen: string[] = [];

    @Route('/e')
    class Grab {
      @Get('/x') x(@needs('events') events: Events) {
        injected = events;
        return {};
      }
    }
    @Module({ mountpoint: '/', controllers: [Grab] })
    class M {}

    const app = createApp({ modules: [M] });
    await app.fetch(new Request('http://x/e/x'));

    // The graph's slice cannot forge an event...
    expect((injected as unknown as { emit?: unknown }).emit).toBeUndefined();

    // ...while the application that owns the app still can, which is what `app.bus` is for.
    app.bus.on('plugin:mounted', (e) => seen.push(e.name));
    app.bus.emit('plugin:mounted', { name: 'from the owner' });
    expect(seen).toEqual(['from the owner']);

    await app.close();
  });
});
