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
