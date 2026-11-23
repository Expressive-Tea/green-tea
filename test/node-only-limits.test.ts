// #76: limits only Node's listener applies are reported by the adapters that ignore them, instead of
// being ignored silently. The Deno and Bun suites check serveDeno and serveBun the same way.
import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { createApp, Module } from '../src/index';
import { edgeHandler } from '../src/edge';

@Module({ mountpoint: '/' })
class M {}

const capture = () => {
  const warned: { message: string; fields: unknown }[] = [];
  const logger = { debug() {}, info() {}, error() {}, warn: (message: string, fields?: unknown) => warned.push({ message, fields }) };
  return { warned, logger };
};

describe('Node-only limits on another adapter', () => {
  it('edgeHandler names each one the app set', () => {
    const { warned, logger } = capture();
    edgeHandler(createApp({ modules: [M], logger, limits: { requestTimeoutMs: 1, keepAliveTimeoutMs: 2, maxBodyBytes: 3 } }));
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toMatch(/edgeHandler does not apply limits\.requestTimeoutMs, limits\.keepAliveTimeoutMs/);
    expect(warned[0].fields).toEqual({ adapter: 'edgeHandler', ignored: ['requestTimeoutMs', 'keepAliveTimeoutMs'] });
  });

  it('stays quiet when none is set', () => {
    const { warned, logger } = capture();
    edgeHandler(createApp({ modules: [M], logger, limits: { maxBodyBytes: 3 } }));
    expect(warned).toEqual([]);
  });
});
