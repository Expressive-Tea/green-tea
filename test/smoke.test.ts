import { expect, test } from 'vitest';
import { VERSION } from '../src/index';

test('package loads and exposes a CalVer VERSION', () => {
  expect(VERSION).toMatch(/^\d{2}\.\d{1,2}\.\d+(-beta\.\d+)?$/);
});
