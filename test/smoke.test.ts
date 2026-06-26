import { expect, test } from 'vitest';
import { VERSION } from '../src/index';

test('package loads and exposes VERSION', () => {
  expect(VERSION).toBe('0.0.0');
});
