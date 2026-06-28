import { describe, expect, it, test } from 'vitest';
import { topoSort, GraphNode, subgraphFor } from '../src/graph';

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

const N = (name: string, needs: string[] = []) => ({ name, needs, provides: [name], origin: 'm' });

describe('subgraphFor', () => {
  const ordered = [N('config'), N('db', ['config']), N('user', ['db', 'req']), N('audit', ['db'])];
  it('returns the transitive closure of needs, in the given order', () => {
    expect(subgraphFor(['user'], ordered).map((n) => n.name)).toEqual(['config', 'db', 'user']);
  });
  it('returns empty for no needs', () => {
    expect(subgraphFor([], ordered)).toEqual([]);
  });
  it('ignores tokens with no producer (seeds/envelope)', () => {
    expect(subgraphFor(['user', 'query', 'req'], ordered).map((n) => n.name)).toEqual(['config', 'db', 'user']);
  });
  it('does not pull in unrelated nodes', () => {
    expect(subgraphFor(['user'], ordered).map((n) => n.name)).not.toContain('audit');
  });
});
