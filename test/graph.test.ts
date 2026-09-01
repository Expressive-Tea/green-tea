import { describe, expect, it, test } from 'vitest';
import { topoSort, topoLevels, GraphNode, subgraphFor, nearest } from '../src/graph';

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

describe('topoLevels', () => {
  const levels = (ordered: GraphNode[]): string[][] => topoLevels(ordered).map((l) => l.map((n) => n.name));

  it('puts nodes that cannot constrain each other in the same level', () => {
    expect(levels([N('a'), N('b'), N('c')])).toEqual([['a', 'b', 'c']]);
  });

  it('pushes a node past every producer it needs, not just its first', () => {
    // `late` needs a depth-0 and a depth-1 node, so it belongs at 2 — taking the max, not the first.
    const ordered = [N('config'), N('db', ['config']), N('late', ['config', 'db'])];
    expect(levels(ordered)).toEqual([['config'], ['db'], ['late']]);
  });

  it('ignores needs nothing here produces, so a seed does not push a node down a level', () => {
    expect(levels([N('a'), N('user', ['req', 'params'])])).toEqual([['a', 'user']]);
  });

  it('leaves no gaps, so every level has something to run', () => {
    const ordered = topoSort([N('c', ['b']), N('a'), N('b', ['a']), N('solo')], []);
    expect(topoLevels(ordered).every((level) => level.length > 0)).toBe(true);
  });

  it('keeps every node exactly once', () => {
    const ordered = topoSort([N('c', ['b']), N('a'), N('b', ['a']), N('solo')], []);
    expect(topoLevels(ordered).flat().map((n) => n.name).sort()).toEqual(['a', 'b', 'c', 'solo']);
  });
});

describe('nearest', () => {
  it('suggests a close candidate (edit distance <= 2)', () => {
    expect(nearest('usr', ['user', 'config', 'db'])).toBe('user');
    expect(nearest('confgi', ['user', 'config'])).toBe('config');
  });
  it('returns undefined when nothing is close', () => {
    expect(nearest('zzzzzz', ['user', 'db'])).toBeUndefined();
  });
});
