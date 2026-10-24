// CARD-18 (GitHub #35, D9): every token has at most one producer across modules, plugins, mesh steps
// and built-ins. A second producer fails `createApp`, naming both nodes and their origins.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../src/index';
import type { Plugin, ScopeNode } from '../src/index';

@Provider({ provides: 'user' })
class User {
  provide() {
    return { user: { id: 'real' } };
  }
}

@Route('/u')
class UserCtl {
  @Get('/me') me(@needs('user') user: unknown) {
    return { user };
  }
}

@Module({ mountpoint: '/', providers: [User], controllers: [UserCtl] })
class AppModule {}

/** A plugin that adds one scope node, the way an official plugin would. */
const adds = (name: string, node: Omit<ScopeNode, 'run'> & Partial<Pick<ScopeNode, 'run'>>): Plugin => ({
  name,
  mount({ scope }) {
    scope.add({ run: () => Object.fromEntries(node.provides.map((key) => [key, `from ${name}`])), ...node });
  },
});

describe('one producer per token', () => {
  it('T1: a plugin node providing a module-provided token fails boot, naming both nodes and origins', () => {
    const shadow = adds('shadow', { kind: 'provider', name: 'shadow', needs: [], provides: ['user'] });
    expect(() => createApp({ modules: [AppModule], plugins: [shadow] })).toThrow(
      "token 'user' is provided twice: by 'user' (module:AppModule) and by 'shadow' (plugin)",
    );
  });

  it('T1: a plugin step providing it fails the same way', () => {
    const shadow = adds('shadow', { kind: 'step', name: 'shadow', needs: [], provides: ['user'] });
    expect(() => createApp({ modules: [AppModule], plugins: [shadow] })).toThrow(/'user' \(module:AppModule\).*'shadow' \(plugin\)/);
  });

  it('T2: a plugin node providing a built-in token fails boot instead of losing silently', () => {
    const fake = adds('fake-logger', { kind: 'provider', name: 'fake-logger', needs: [], provides: ['logger'] });
    // Plugins mount before the built-ins are registered, so the plugin is the one seen first. The
    // order the two are reported in is not the point; that both are, with their origins, is.
    expect(() => createApp({ modules: [AppModule], plugins: [fake] })).toThrow(
      "token 'logger' is provided twice: by 'fake-logger' (plugin) and by 'logger' (builtin)",
    );
  });

  it.each(['rooms', 'events'])('T2: the same holds for the built-in %s', (token) => {
    const fake = adds('fake', { kind: 'provider', name: 'fake', needs: [], provides: [token] });
    expect(() => createApp({ modules: [AppModule], plugins: [fake] })).toThrow(`token '${token}' is provided twice`);
  });

  it('T3: a plugin node providing two tokens, one of them taken, fails naming the taken one', () => {
    const both = adds('both', { kind: 'provider', name: 'both', needs: [], provides: ['a', 'user'] });
    expect(() => createApp({ modules: [AppModule], plugins: [both] })).toThrow(/^token 'user' is provided twice/);
  });

  it('T4: two plugins providing distinct tokens boot', async () => {
    const a = adds('a', { kind: 'provider', name: 'a', needs: [], provides: ['a'] });
    const b = adds('b', { kind: 'provider', name: 'b', needs: [], provides: ['b'] });
    const app = createApp({ modules: [AppModule], plugins: [a, b] });
    await expect(app.boot()).resolves.toBeUndefined();
  });

  it('two plugin nodes providing the same token fail, naming both', () => {
    const a = adds('a', { kind: 'step', name: 'a', needs: [], provides: ['shared'] });
    const b = adds('b', { kind: 'step', name: 'b', needs: [], provides: ['shared'] });
    expect(() => createApp({ modules: [AppModule], plugins: [a, b] })).toThrow(
      "token 'shared' is provided twice: by 'a' (plugin) and by 'b' (plugin)",
    );
  });

  it('observer steps that provide nothing do not count as producers', async () => {
    const one = adds('one', { kind: 'step', name: 'one', needs: [], provides: [] });
    const two = adds('two', { kind: 'step', name: 'two', needs: [], provides: [] });
    await expect(createApp({ modules: [AppModule], plugins: [one, two] }).boot()).resolves.toBeUndefined();
  });

  // GitHub #43. "Provided by another node" cannot rescue a self-dependency: a second producer of
  // `user` is the CARD-18 failure above. And an override changes a runner, not the graph, so the
  // check that rejects the node runs before any override could.
  it('a node that needs the token it provides fails boot, with or without an override', () => {
    const loop = adds('loop', { kind: 'step', name: 'loop', needs: ['loop'], provides: ['loop'] });
    expect(() => createApp({ modules: [AppModule], plugins: [loop] })).toThrow(/cycle detected: loop -> loop/);
    expect(() => createApp({ modules: [AppModule], plugins: [loop], overrides: { loop: 1 } })).toThrow(
      /cycle detected: loop -> loop/,
    );
  });

  it('T5: overrides replace the runner of an existing token, not add a producer', async () => {
    const app = createApp({ modules: [AppModule], overrides: { user: { id: 1 } } });
    const res = await app.fetch(new Request('http://x/u/me'));
    expect(await res.json()).toEqual({ user: { id: 1 } });
  });

});

describe('one producer per token: mesh', () => {
  const SECRET = 's3cr3t';

  @Step({ provides: 'auth', needs: [], export: true })
  class RemoteAuth {
    run() {
      return { auth: 'remote' };
    }
  }
  @Module({ mountpoint: '/', steps: [RemoteAuth] })
  class TeapotModule {}

  @Step({ provides: 'auth', needs: [] })
  class LocalAuth {
    run() {
      return { auth: 'local' };
    }
  }
  @Route('/a')
  class AuthCtl {
    @Get('/who') who(@needs('auth') auth: unknown) {
      return { auth };
    }
  }
  @Module({ mountpoint: '/', steps: [LocalAuth], controllers: [AuthCtl] })
  class TeacupModule {}

  it('T6: a remote step whose token a local node provides still fails at splice', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const server = await teapot.listen(0);
    const url = `ws://127.0.0.1:${(server.address() as any).port}/__mesh__/control`;
    const teacup = createApp({ modules: [TeacupModule], experimental: true, mesh: { teapots: [{ url, secret: SECRET }] } });

    try {
      await expect(teacup.ready()).rejects.toThrow("duplicate provider/step name 'auth'");
    } finally {
      await teacup.close().catch(() => {});
      await teapot.close();
    }
  });
});
