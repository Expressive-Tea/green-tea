// #87: mesh cannot run on the edge, so an app that configures it is refused there with a message
// that says so, instead of booting and failing later. The workerd run is in test/edge/run.ts.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, Module } from '../../src/index';
import { edgeHandler } from '../../src/edge';

@Module({ mountpoint: '/' })
class M {}

const meshApp = () => createApp({ modules: [M], experimental: true, mesh: { secret: 'x' } });

describe('mesh on the edge', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('edgeHandler refuses an app configured with mesh', () => {
    expect(() => edgeHandler(meshApp())).toThrow(/mesh does not run on the edge/);
  });

  it('createApp refuses mesh when it detects a Workers isolate', () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    expect(meshApp).toThrow(/mesh does not run on the edge/);
  });

  it('leaves an app without mesh alone', () => {
    expect(() => edgeHandler(createApp({ modules: [M] }))).not.toThrow();
  });
});
