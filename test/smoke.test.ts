import { expect, test } from 'vitest';
import { Head, Options, VERSION, type HttpMethod } from '../src/index';

test('package loads and exposes a CalVer VERSION', () => {
  expect(VERSION).toMatch(/^\d{2}\.\d{1,2}\.\d+(-beta\.\d+)?$/);
});

test('public barrel exports HEAD and OPTIONS route decorators', () => {
  const methods: HttpMethod[] = ['HEAD', 'OPTIONS'];
  expect(Head).toBeTypeOf('function');
  expect(Options).toBeTypeOf('function');
  expect(methods).toEqual(['HEAD', 'OPTIONS']);
});
