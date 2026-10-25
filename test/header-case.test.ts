// GitHub #37: `@header('Content-Type')` reached the handler as undefined, because every adapter
// stores header names lower-cased and the lookup used the name as written.
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, Get, Module, Route, header } from '../src/index';

@Route('/')
class Ctl {
  @Get('/h') h(@header('Content-Type') ct: unknown, @header('X-Trace') trace: unknown) {
    return { ct: ct ?? null, trace: trace ?? null };
  }
}

@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

const sent = { 'content-type': 'text/plain', 'x-trace': 'abc' };
const expected = { ct: 'text/plain', trace: 'abc' };

describe('@header matches the name without case (GitHub #37)', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('on app.fetch', async () => {
    const app = createApp({ modules: [M] });
    expect(await (await app.fetch(new Request('http://x/h', { headers: sent }))).json()).toEqual(expected);
  });

  it('on the Node server', async () => {
    server = await createApp({ modules: [M] }).listen(0);
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/h`, { headers: sent });
    expect(await r.json()).toEqual(expected);
  });
});
