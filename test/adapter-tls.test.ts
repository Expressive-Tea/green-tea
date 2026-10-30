import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src';
import { serveDeno } from '../src/deno';
import { serveBun } from '../src/bun';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Only Node's `listen()` reads `tls`. Deno and Bun serve through their own listener, so an app
// created with `tls` would come up as plain HTTP there — refused before anything binds.
it.each([
  ['serveDeno', 'Deno', serveDeno],
  ['serveBun', 'Bun', serveBun],
] as const)('%s refuses an app created with tls', async (name, global, serve) => {
  const listen = vi.fn();
  vi.stubGlobal(global, { serve: listen });
  const app = createApp({ modules: [], tls: { key: 'k', cert: 'c' } });

  await expect(serve(app)).rejects.toThrow(`${name} does not support createApp({ tls })`);
  expect(listen).not.toHaveBeenCalled();
});

it('an app without tls is not refused', async () => {
  const listen = vi.fn(() => ({ port: 0, stop: vi.fn() }));
  vi.stubGlobal('Bun', { serve: listen });

  await serveBun(createApp({ modules: [] }));
  expect(listen).toHaveBeenCalledOnce();
});
