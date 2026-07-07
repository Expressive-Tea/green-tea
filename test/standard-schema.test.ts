import { describe, it, expect } from 'vitest';
import { isStandardSchema, flattenPath } from '../src/standard-schema';

const schema = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } };

describe('isStandardSchema', () => {
  it('true for a Standard Schema, false for string/array/plain object/null', () => {
    expect(isStandardSchema(schema)).toBe(true);
    expect(isStandardSchema('id')).toBe(false);
    expect(isStandardSchema(['a', 'b'])).toBe(false);
    expect(isStandardSchema({})).toBe(false);
    expect(isStandardSchema(null)).toBe(false);
    expect(isStandardSchema({ '~standard': {} })).toBe(false); // no validate fn
  });
});

describe('flattenPath', () => {
  it('flattens key + {key} segments to a dot string', () => {
    expect(flattenPath({ message: 'x', path: ['address', 'city'] })).toBe('address.city');
    expect(flattenPath({ message: 'x', path: ['items', 0, { key: 'qty' }] })).toBe('items.0.qty');
    expect(flattenPath({ message: 'x' })).toBe('');
  });
});
