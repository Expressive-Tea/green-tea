// test/plugin-contract.test.ts
import { describe, expect, it, vi } from 'vitest';

import { createApp, Get, Module, Route, needs } from '../src/index';
import type { Plugin } from '../src/index';

@Route('/')
class Ctl {
  @Get('/who')
  who(@needs('who') who: string) {
    return { who };
  }
}

@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

const provides = (name: string, value: string): Plugin => ({
  name,
  mount({ scope }) {
    scope.add({ kind: 'provider', name, needs: [], provides: [name], run: async () => ({ [name]: value }) });
  },
});

describe('the plugin contract', () => {
  it('mounts an object plugin and its node reaches a handler', async () => {
    const app = createApp({ modules: [M], plugins: [provides('who', 'jwt')] });

    const response = await app.fetch(new Request('http://x/who'));

    expect(await response.json()).toEqual({ who: 'jwt' });
  });

  it('names the plugin whose mount threw', () => {
    const boom: Plugin = {
      name: 'boom',
      mount() {
        throw new Error('no key');
      },
    };

    expect(() => createApp({ modules: [M], plugins: [boom] })).toThrow(
      /plugin "boom" failed to mount: no key/,
    );
  });

  it('keeps the original error as the cause', () => {
    const original = new Error('no key');
    const boom: Plugin = {
      name: 'boom',
      mount() {
        throw original;
      },
    };

    try {
      createApp({ modules: [M], plugins: [boom] });
      expect.unreachable('createApp should have thrown');
    } catch (error) {
      expect((error as Error).cause).toBe(original);
    }
  });

  // The two plugins provide *different* tokens, so nothing but the duplicate-name check can fail
  // this. Two plugins providing the same token would also collide inside `setRunner`, which
  // enforces unique node names already — and the test would pass without the new code.
  it('refuses two plugins with the same name, even when they provide different tokens', () => {
    const twin = (token: string): Plugin => ({
      name: 'twin',
      mount({ scope }) {
        scope.add({ kind: 'provider', name: token, needs: [], provides: [token], run: async () => ({ [token]: 1 }) });
      },
    });

    expect(() => createApp({ modules: [M], plugins: [twin('a'), twin('b')] })).toThrow(
      /two plugins are named "twin"/,
    );
  });

  // `plugin:mounted` means "this plugin is in". A plugin whose mount threw is not, and announcing
  // it would put a name in the lifecycle stream for something that never registered anything.
  it('does not announce a plugin whose mount threw', () => {
    const seen = vi.fn();
    const observer: Plugin = {
      name: 'observer',
      mount({ bus }) {
        bus.on('plugin:mounted', seen);
      },
    };
    const boom: Plugin = {
      name: 'boom',
      mount() {
        throw new Error('no key');
      },
    };

    expect(() => createApp({ modules: [M], plugins: [observer, boom] })).toThrow(/failed to mount/);
    expect(seen).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'boom' }));
  });

  it('reports the name on plugin:mounted', () => {
    const seen = vi.fn();
    // `createApp` takes no `bus` option, and the event
    // fires during construction — so the observer has to be a plugin, listed first, because
    // plugins mount in the order they are given.
    const observer: Plugin = {
      name: 'observer',
      mount({ bus }) {
        bus.on('plugin:mounted', seen);
      },
    };

    createApp({ modules: [M], plugins: [observer, provides('who', 'jwt')] });

    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ name: 'who' }));
  });
});
