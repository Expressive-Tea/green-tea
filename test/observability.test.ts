import { describe, it, expect } from 'vitest';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../src/index';
import type { EventPayload } from '../src/bus';
import { UNMATCHED_ROUTE } from '../src/index';

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
    // Carries what was actually sent, so an error counter can break down by status without
    // joining back to the `request:end` that follows it.
    expect(requestFailures[0].status).toBe(500);
  });

  // The cardinality trap: `name` carries the path that arrived, which is bounded by nothing at all.
  // A consumer labelling on `route` gets one bounded series for every path that was never a route;
  // one labelling on `name` gets a series per scanner probe.
  it('labels an unmatched request with a bounded route, on both events', async () => {
    const app = createApp({ modules: [BadModule] });
    const unmatched: EventPayload[] = [];
    const ends: EventPayload[] = [];
    app.bus.on('route:unmatched', (p) => unmatched.push(p));
    app.bus.on('request:end', (p) => ends.push(p));

    for (const probe of ['/aaa', '/aab', '/aac']) await app.fetch(new Request(`http://x${probe}`));

    expect(unmatched).toHaveLength(3);
    expect(ends).toHaveLength(3);
    // Three distinct paths, one series.
    expect(new Set(unmatched.map((e) => e.route))).toEqual(new Set([UNMATCHED_ROUTE]));
    expect(new Set(ends.map((e) => e.route))).toEqual(new Set([UNMATCHED_ROUTE]));
    // `name` still carries the concrete path, which is what makes it useful in a log and unusable
    // as a label.
    expect(new Set(unmatched.map((e) => e.name)).size).toBe(3);
    // It cannot collide with a pattern a user can declare.
    expect(UNMATCHED_ROUTE.startsWith('/')).toBe(false);
  });

  it('leaves a matched route labelled with its pattern, not the marker', async () => {
    const app = createApp({ modules: [BadModule] });
    const ends: EventPayload[] = [];
    app.bus.on('request:end', (p) => ends.push(p));

    await app.fetch(new Request('http://x/bad/go'));

    expect(ends[0].route).toBe('/bad/go');
  });

  // The three-event overlap, asserted rather than described: one failing request, three events,
  // one requestId. A consumer that counts `request:failed` and `request:end` as separate outcomes
  // counts this request twice — which is the mistake the payload docs now name.
  it('emits start, failed and end for one failing request, all sharing a requestId', async () => {
    const app = createApp({ modules: [BadModule] });
    const seen: Array<{ event: string; payload: EventPayload }> = [];
    for (const event of ['request:start', 'request:failed', 'request:end'] as const)
      app.bus.on(event, (payload) => seen.push({ event, payload }));

    await app.fetch(new Request('http://x/bad/go'));

    expect(seen.map((s) => s.event)).toEqual(['request:start', 'request:failed', 'request:end']);
    expect(new Set(seen.map((s) => s.payload.requestId)).size).toBe(1);
    // `request:end` is the terminal one and the only one that fires for every request shape; it is
    // what a request counter counts.
    expect(seen[2].payload.status).toBe(500);
  });

  // `onError` may turn any throw into any status, so a status derived from the error rather than
  // from the render would be a guess that a custom renderer makes wrong.
  it('reports the status a custom onError produced, not the one the error implied', async () => {
    const app = createApp({
      modules: [BadModule],
      onError: () => ({ status: 418, headers: {}, body: 'teapot' }),
    });
    const failures: EventPayload[] = [];
    app.bus.on('request:failed', (p) => failures.push(p));

    const res = await app.fetch(new Request('http://x/bad/go'));

    expect(res.status).toBe(418);
    expect(failures).toHaveLength(1);
    expect(failures[0].status).toBe(418);
  });

  // A renderer that throws must not swallow the event — the failure still happened, and losing the
  // only record of it because the reporting of it broke is the worst possible trade. The status is
  // the built-in renderer's, since that is what the request actually got.
  it('still reports the failure when onError itself throws', async () => {
    const app = createApp({
      modules: [BadModule],
      onError: () => {
        throw new Error('renderer exploded');
      },
    });
    const failures: EventPayload[] = [];
    app.bus.on('request:failed', (p) => failures.push(p));

    const res = await app.fetch(new Request('http://x/bad/go'));

    expect(res.status).toBe(500);
    expect(failures).toHaveLength(1);
    expect(failures[0].status).toBe(500);
    // The request's error, not the renderer's — they are different errors and the event names the
    // one the request suffered.
    expect((failures[0].error as Error).message).toBe('step exploded');
  });
});
