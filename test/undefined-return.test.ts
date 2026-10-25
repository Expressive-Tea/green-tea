// GitHub #38: `JSON.stringify(undefined)` is `undefined`, so a handler with no `return` gave an
// empty 200 on Node and a 500 (a TypeError in the fetch adapter) on Deno, Bun and the edge. It now
// answers 204 with no body everywhere.
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, Get, Module, Route } from '../src/index';

@Route('/')
class Ctl {
  @Get('/none') none() {}
  @Get('/null') nul() {
    return null;
  }
}

@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

describe('a handler that returns undefined answers 204 (GitHub #38)', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('on app.fetch', async () => {
    const r = await createApp({ modules: [M] }).fetch(new Request('http://x/none'));
    expect(r.status).toBe(204);
    expect(r.headers.get('content-type')).toBeNull();
    expect(await r.text()).toBe('');
  });

  it('on the Node server', async () => {
    server = await createApp({ modules: [M] }).listen(0);
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/none`);
    expect(r.status).toBe(204);
    expect(r.headers.get('content-type')).toBeNull();
    expect(await r.text()).toBe('');
  });

  it('null is still a JSON value: 200 with `null`', async () => {
    const r = await createApp({ modules: [M] }).fetch(new Request('http://x/null'));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('null');
  });
});
