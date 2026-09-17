// test/app-boot.test.ts
import { describe, expect, it, vi } from 'vitest';

import { createApp, Get, Module, Route, needs } from '../src/index';
import type { Plugin } from '../src/index';

@Route('/')
class Ctl {
  @Get('/x')
  x(@needs('thing') thing: string) {
    return { thing };
  }
}

@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

const plugin = (run: () => Promise<Record<string, unknown>>): Plugin => ({
  name: 'thing',
  mount({ scope }) {
    scope.add({ kind: 'provider', name: 'thing', needs: [], provides: ['thing'], run });
  },
});

describe('app.boot()', () => {
  it('surfaces a failing provider instead of leaving it for the first request', async () => {
    const app = createApp({ modules: [M], plugins: [plugin(async () => { throw new Error('bad key'); })] });

    await expect(app.boot()).rejects.toThrow(/bad key/);
  });

  it('runs provider factories exactly once, and serves afterwards', async () => {
    const run = vi.fn(async () => ({ thing: 'ok' }));
    const app = createApp({ modules: [M], plugins: [plugin(run)] });

    await app.boot();
    await app.boot();
    const response = await app.fetch(new Request('http://x/x'));

    expect(run).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({ thing: 'ok' });
  });

  // The memo keeps the rejection, which is exactly why a failed boot answers 500 for the life of
  // the process instead of retrying. It is the documented behaviour, so it gets a test rather than
  // a sentence: if it ever starts retrying, the guide in Task 7 becomes wrong.
  it('keeps a failed boot failed', async () => {
    const run = vi.fn(async () => {
      throw new Error('bad key');
    });
    const app = createApp({ modules: [M], plugins: [plugin(run)] });

    await expect(app.boot()).rejects.toThrow(/bad key/);
    await expect(app.boot()).rejects.toThrow(/bad key/);
    await expect(app.fetch(new Request('http://x/x'))).rejects.toThrow(/bad key/);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
