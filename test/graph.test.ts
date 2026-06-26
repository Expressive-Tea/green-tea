import { expect, test } from 'vitest';
import { topoSort, GraphNode } from '../src/graph';

const node = (name: string, needs: string[], provides: string[]): GraphNode =>
  ({ name, needs, provides, origin: 'test' });

test('orders nodes so dependencies come first (regardless of input order)', () => {
  const nodes = [
    node('handler', ['user'], []),
    node('auth', ['db'], ['user']),
    node('db', ['config'], ['db']),
  ];
  const ordered = topoSort(nodes, ['config']).map((n) => n.name);
  expect(ordered).toEqual(['db', 'auth', 'handler']);
});

test('throws on missing dependency', () => {
  const nodes = [node('handler', ['user'], [])];
  expect(() => topoSort(nodes, [])).toThrow(/missing dependency: user needed by handler/);
});

test('throws on cycle', () => {
  const nodes = [node('a', ['b'], ['a']), node('b', ['a'], ['b'])];
  expect(() => topoSort(nodes, [])).toThrow(/cycle detected/);
});
