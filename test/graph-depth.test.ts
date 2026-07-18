import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { createApp, Step, Route, Get, Module, needs } from '../src/index';

// Builds a module with an n-deep chain: s1..sn (each needs the previous) + a route that @needs the last.
function deepModule(n: number) {
  const steps = Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    @Step({ provides: `s${k}`, needs: k > 1 ? [`s${k - 1}`] : [] })
    class S { run() { return { [`s${k}`]: k }; } }
    return S;
  });

  @Route('/')
  class C { @Get('/deep') deep(@needs(`s${n}`) s: number) { return { s }; } }

  @Module({ mountpoint: '/', steps, controllers: [C] })
  class M {}
  return M;
}

describe('deep-graph warning', () => {
  it('warns at boot when a route resolves to more than 20 steps', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createApp({ modules: [deepModule(25)] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('25 steps'));
    warn.mockRestore();
  });

  it('stays quiet under the threshold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createApp({ modules: [deepModule(10)] });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warnGraphDepth: false silences it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createApp({ modules: [deepModule(25)], warnGraphDepth: false });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warnGraphDepth tunes the threshold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createApp({ modules: [deepModule(10)], warnGraphDepth: 5 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('10 steps'));
    warn.mockRestore();
  });
});
