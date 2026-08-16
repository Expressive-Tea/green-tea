import { describe, it, expect } from 'vitest';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../src/index';
import type { EventPayload } from '../src/bus';

@Provider({ provides: 'db' })
class Db {
  provide() {
    return { db: { name: 'db' } };
  }
}

// Yields inside the step so two concurrent requests genuinely interleave their events rather
// than each running to completion before the other starts. Without that, the correlation bug
// this file exists to catch would not even show up.
@Step({ provides: 'user', needs: ['db'] })
class LoadUser {
  async run() {
    await new Promise((r) => setTimeout(r, 10));
    return { user: { id: 'u1' } };
  }
}

@Step({ provides: 'profile', needs: ['user'] })
class LoadProfile {
  async run() {
    await new Promise((r) => setTimeout(r, 10));
    return { profile: { theme: 'dark' } };
  }
}

@Route('/api')
class Ctl {
  @Get('/me')
  me(@needs('profile') profile: unknown) {
    return { profile };
  }
}

@Module({ mountpoint: '/', providers: [Db], steps: [LoadUser, LoadProfile], controllers: [Ctl] })
class M {}

describe('event correlation', () => {
  it('attributes every step event to the request that caused it', async () => {
    const app = createApp({ modules: [M] });
    const seen: EventPayload[] = [];
    app.bus.on('request:step:enter', (p) => seen.push(p));
    app.bus.on('request:step:leave', (p) => seen.push(p));

    // Concurrent on purpose: this is the only condition under which the defect appears.
    await Promise.all([
      app.fetch(new Request('http://x/api/me')),
      app.fetch(new Request('http://x/api/me')),
    ]);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((event) => typeof event.requestId === 'string' && event.requestId.length > 0)).toBe(true);

    // Two requests, two identities, and no event belonging to both.
    const ids = new Set(seen.map((event) => event.requestId));
    expect(ids.size).toBe(2);

    // Each request must show its own complete run of the pipeline, which is the whole point of
    // correlating: counting events globally would pass even with the ids shuffled.
    // A step is named by what it `provides`, not by its class.
    for (const id of ids) {
      const forRequest = seen.filter((event) => event.requestId === id);
      expect(forRequest.filter((e) => e.name === 'user')).toHaveLength(2); // enter + leave
      expect(forRequest.filter((e) => e.name === 'profile')).toHaveLength(2);
    }
  });

  it('labels events with the route pattern, never the concrete path', async () => {
    @Route('/things')
    class Things {
      // Needs a step on purpose: green-tea prunes steps no handler depends on, so a route that
      // needs nothing emits no step events and the assertion below would have nothing to read.
      @Get('/:id')
      one(@needs('user') user: unknown) {
        return { user };
      }
    }
    @Module({ mountpoint: '/', providers: [Db], steps: [LoadUser, LoadProfile], controllers: [Things] })
    class ParamModule {}

    const app = createApp({ modules: [ParamModule] });
    const seen: EventPayload[] = [];
    app.bus.on('request:step:leave', (p) => seen.push(p));

    await app.fetch(new Request('http://x/things/42'));
    await app.fetch(new Request('http://x/things/1337'));

    expect(seen.length).toBeGreaterThan(0);
    // Two distinct URLs, one label. Labelling on the raw path is what gives a metrics backend
    // unbounded cardinality, so this is a contract and not an implementation detail.
    expect(new Set(seen.map((e) => e.route))).toEqual(new Set(['/things/:id']));
  });

  it('times each step and reports it on leave', async () => {
    const app = createApp({ modules: [M] });
    const seen: EventPayload[] = [];
    app.bus.on('request:step:leave', (p) => seen.push(p));

    await app.fetch(new Request('http://x/api/me'));

    // Both steps sleep 10ms. Assert a range, never a value — a clock is not a promise.
    expect(seen).toHaveLength(2);
    for (const event of seen) {
      expect(event.durationMs).toBeGreaterThan(5);
      expect(event.durationMs).toBeLessThan(500);
    }
  });
  it('adopts an incoming x-request-id instead of starting a second identity', async () => {
    const app = createApp({ modules: [M] });
    const seen: EventPayload[] = [];
    app.bus.on('request:step:enter', (p) => seen.push(p));

    await app.fetch(new Request('http://x/api/me', { headers: { 'x-request-id': 'from-the-gateway' } }));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((event) => event.requestId === 'from-the-gateway')).toBe(true);
  });

  it('carries traceparent through as traceId without parsing it', async () => {
    const app = createApp({ modules: [M] });
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const seen: EventPayload[] = [];
    app.bus.on('request:step:enter', (p) => seen.push(p));

    await app.fetch(new Request('http://x/api/me', { headers: { traceparent } }));

    expect(seen.length).toBeGreaterThan(0);
    // Verbatim: core implements no propagation spec, that belongs to the exporter.
    expect(seen.every((event) => event.traceId === traceparent)).toBe(true);
  });
});

describe('failure reporting', () => {
  @Step({ provides: 'ok' })
  class Fine {
    run() {
      return { ok: true };
    }
  }
  @Step({ provides: 'boom', needs: ['ok'] })
  class Boom {
    run(): never {
      throw new Error('step exploded');
    }
  }
  @Route('/bad')
  class BadCtl {
    @Get('/go')
    go(@needs('boom') b: unknown) {
      return { b };
    }
  }
  @Module({ mountpoint: '/', steps: [Fine, Boom], controllers: [BadCtl] })
  class BadModule {}

  it('names the step that failed, and marks the request failed once', async () => {
    const app = createApp({ modules: [BadModule] });
    const stepErrors: EventPayload[] = [];
    const requestFailures: EventPayload[] = [];
    app.bus.on('request:step:error', (p) => stepErrors.push(p));
    app.bus.on('request:failed', (p) => requestFailures.push(p));

    await app.fetch(new Request('http://x/bad/go'));

    // The defect this replaces reported every failure as name: 'pipeline'.
    expect(stepErrors).toHaveLength(1);
    expect(stepErrors[0].name).toBe('boom');
    expect((stepErrors[0].error as Error).message).toBe('step exploded');

    // Both fire, on purpose: one marks the span, the other the trace.
    expect(requestFailures).toHaveLength(1);
    expect(requestFailures[0].route).toBe('/bad/go');
    expect(requestFailures[0].requestId).toBe(stepErrors[0].requestId);
  });

});
