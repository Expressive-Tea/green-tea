/**
 * The contracts a node and a handler are held to, enforced rather than assumed. `provide()` and
 * `run()` return an object holding every token they provide; a handler returns a value, not a
 * Fetch `Response`. Before RC.1, breaking either was silent: the token came out `undefined` (with
 * the returned object's own properties spread over the request context), or the response went
 * out as `200 {}`.
 */
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { createApp, Module, Provider, Route, Get, Step, needs } from '../src/index';
import type { Plugin } from '../src/plugin';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Captures the error a request failed with, and answers 500 with its message. */
function capture() {
  const seen: { error?: unknown } = {};
  const onError = (error: unknown) => {
    seen.error = error;
    return { status: 500, headers: {}, body: JSON.stringify({ message: (error as Error).message }) };
  };
  return { seen, onError };
}

describe('provide() must return an object keyed by its token', () => {
  it('a provider returning the bare value fails the boot, naming the fix', async () => {
    @Provider({ provides: 'db' })
    class Db {
      provide() {
        return { query: () => [] }; // the client itself, not { db: client }
      }
    }
    @Route('/')
    class C {
      @Get('/') get(@needs('db') db: unknown) {
        return { db: db !== undefined };
      }
    }
    @Module({ mountpoint: '/', providers: [Db], controllers: [C] })
    class M {}

    const app = createApp({ modules: [M], logger: quiet });
    await expect(app.boot()).rejects.toThrow(
      "provider 'db' returned an object with 'query', but it must return an object holding what it provides: return { db: <value> }",
    );
  });

  it('an async provider resolving to a non-object fails the boot too', async () => {
    @Provider({ provides: 'config' })
    class Config {
      async provide() {
        return 'production';
      }
    }
    @Module({ mountpoint: '/', providers: [Config] })
    class M {}

    await expect(createApp({ modules: [M], logger: quiet }).boot()).rejects.toThrow(
      "provider 'config' returned a string",
    );
  });

  it('a keyed provider whose value is undefined is still keyed, and boots', async () => {
    @Provider({ provides: 'cache' })
    class Cache {
      provide() {
        return { cache: undefined };
      }
    }
    @Module({ mountpoint: '/', providers: [Cache] })
    class M {}

    await expect(createApp({ modules: [M], logger: quiet }).boot()).resolves.toBeUndefined();
  });
});

describe('run() must return an object keyed by its token', () => {
  it('a step returning nothing fails the request with a message that names the step and the fix', async () => {
    @Step({ provides: 'user', needs: ['req'] })
    class Auth {
      run() {
        // forgot `return { user }`
      }
    }
    @Route('/')
    class C {
      @Get('/me') me(@needs('user') user: unknown) {
        return { user };
      }
    }
    @Module({ mountpoint: '/', steps: [Auth], controllers: [C] })
    class M {}

    const { seen, onError } = capture();
    const res = await createApp({ modules: [M], logger: quiet, onError }).fetch(new Request('http://x/me'));
    expect(res.status).toBe(500);
    expect((seen.error as Error).message).toBe(
      "step 'user' returned undefined, but it must return an object holding what it provides: return { user: <value> }",
    );
  });

  it('a step returning its token keyed works as before', async () => {
    @Step({ provides: 'user', needs: ['req'] })
    class Auth {
      run() {
        return { user: 'ana' };
      }
    }
    @Route('/')
    class C {
      @Get('/me') me(@needs('user') user: string) {
        return { user };
      }
    }
    @Module({ mountpoint: '/', steps: [Auth], controllers: [C] })
    class M {}

    const res = await createApp({ modules: [M], logger: quiet }).fetch(new Request('http://x/me'));
    expect(await res.json()).toEqual({ user: 'ana' });
  });

  it('a plugin node is held to the same contract for every token it provides', async () => {
    const plugin: Plugin = {
      name: 'audit',
      mount(api) {
        api.scope.add({ kind: 'step', name: 'audit', needs: [], provides: ['audit', 'auditId'], run: () => ({ audit: true }) });
      },
    };
    @Route('/')
    class C {
      @Get('/') get(@needs('auditId') id: unknown) {
        return { id };
      }
    }
    @Module({ mountpoint: '/', controllers: [C] })
    class M {}

    const { seen, onError } = capture();
    const res = await createApp({ modules: [M], plugins: [plugin], logger: quiet, onError }).fetch(new Request('http://x/'));
    expect(res.status).toBe(500);
    expect((seen.error as Error).message).toContain("plugin step 'audit' returned an object with 'audit'");
    expect((seen.error as Error).message).toContain('return { audit: <value>, auditId: <value> }');
  });
});

describe('a handler returns a value, not a Response', () => {
  it('a returned Response fails the request instead of going out as 200 {}', async () => {
    @Route('/')
    class C {
      @Get('/') get() {
        return new Response('created', { status: 201 });
      }
    }
    @Module({ mountpoint: '/', controllers: [C] })
    class M {}

    const { seen, onError } = capture();
    const res = await createApp({ modules: [M], logger: quiet, onError }).fetch(new Request('http://x/'));
    expect(res.status).toBe(500);
    expect((seen.error as Error).message).toContain('a handler returned a Response object');
    expect((seen.error as Error).message).toContain('@Transformer');
  });
});
