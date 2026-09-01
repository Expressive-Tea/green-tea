import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { Route, Get, Module } from '../src/metadata';
import { HttpError, Unauthorized, isHttpError } from '../src/signals';
import type { ErrorRenderer } from '../src/transformers';

// Renders every error as HTML, reading the status off HttpError when present.
const htmlErrors: ErrorRenderer = (error) => ({
  status: isHttpError(error) ? error.status : 500,
  headers: { 'content-type': 'text/html' },
  body: `<h1>${isHttpError(error) ? error.status : 500}</h1>`,
});

@Route('/x')
class Ctl {
  @Get('/boom') boom() {
    throw new Unauthorized('nope');
  }
  @Get('/ok') ok() {
    return { ok: true };
  }
  @Get('/teapot') teapot() {
    throw new HttpError(418, 'short and stout', { code: 'TEA', reason: 'short and stout' });
  }
}
@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

async function serve(onError?: ErrorRenderer) {
  const app = createApp({ modules: [M], onError });
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('onError renderer', () => {
  it('renders a handler-thrown error through the hook (HTML, right status)', async () => {
    const { server, base } = await serve(htmlErrors);
    const res = await fetch(`${base}/x/boom`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('<h1>401</h1>');
    server.close();
  });

  it('renders infra errors too — a no-route 404 goes through the hook', async () => {
    const { server, base } = await serve(htmlErrors);
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('<h1>404</h1>');
    server.close();
  });

  it('falls back to the default JSON when the hook returns undefined', async () => {
    const { server, base } = await serve(() => undefined);
    const res = await fetch(`${base}/x/boom`);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ error: 'nope' });
    server.close();
  });

  it('with no hook, behavior is unchanged (default JSON 404)', async () => {
    const { server, base } = await serve();
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found' });
    server.close();
  });
});

describe('HttpError body', () => {
  it('an HttpError carrying a body renders that payload instead of { error: message }', async () => {
    const { server, base } = await serve();
    const res = await fetch(`${base}/x/teapot`);
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ code: 'TEA', reason: 'short and stout' });
    server.close();
  });
});

// `onError` is user code, on the request path, running *after something already went wrong*. An
// unguarded throw here was the worst-timed crash in the framework: the error occurs, the code
// written to report it fails, and the process ends instead of degrading. It was also easy to
// reach — the renderer produces the 404 too, so an app with a custom renderer and no matching
// route was one request away from exiting.
describe('an onError that throws', () => {
  const exploding: ErrorRenderer = () => {
    throw new Error('renderer exploded');
  };

  @Route('/x')
  class Boom {
    @Get('/boom') boom() {
      throw new HttpError(503, 'Service Unavailable');
    }
  }

  @Module({ mountpoint: '/', controllers: [Boom] })
  class BoomModule {}

  it('falls back to the built-in rendering rather than losing the response', async () => {
    const app = createApp({ modules: [BoomModule], onError: exploding });
    const res = await app.fetch(new Request('http://x/x/boom'));

    // The original error still gets its answer: the fallback is the rendering `onError` overrides.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Service Unavailable' });
  });

  // The path that needed no thrown handler at all.
  it('survives a 404, which the renderer also produces', async () => {
    const app = createApp({ modules: [BoomModule], onError: exploding });
    const res = await app.fetch(new Request('http://x/nothing-here'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found' });
  });

  it('reports the renderer as the thing that failed, not the request', async () => {
    const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error(msg: string, fields?: Record<string, unknown>) {
        logged.push({ msg, fields });
      },
    };
    const app = createApp({ modules: [BoomModule], onError: exploding, logger });

    await app.fetch(new Request('http://x/x/boom'));

    expect(logged).toHaveLength(1);
    expect(logged[0].msg).toMatch(/onError/);
    // Both errors named, because a reader chasing the wrong one loses an afternoon.
    expect(logged[0].fields?.err).toBe('renderer exploded');
    expect(logged[0].fields?.rendering).toBe('Service Unavailable');
  });

  it('answers over a real Node server instead of exiting the process', async () => {
    const app = createApp({ modules: [BoomModule], onError: exploding });
    const server = await app.listen(0);
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/x/boom`);
    expect(res.status).toBe(503);
    // Still serving — the point of the whole test.
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);

    await app.close();
  });
});
