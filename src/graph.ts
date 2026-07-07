function levenshtein(a: string, b: string): number {
  const aLen = a.length,
    bLen = b.length;
  const matrix: number[][] = Array.from({ length: aLen + 1 }, () => Array(bLen + 1).fill(0));
  for (let i = 0; i <= aLen; i++) matrix[i][0] = i;
  for (let j = 0; j <= bLen; j++) matrix[0][j] = j;

  for (let i = 1; i <= aLen; i++)
    for (let j = 1; j <= bLen; j++) {
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }

  return matrix[aLen][bLen];
}

/** Returns the candidate within edit distance 2 of `token`, for "did you mean?" hints. */
export function nearest(token: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = 3; // only suggest edit distance <= 2

  for (const candidate of candidates) {
    const distance = levenshtein(token, candidate);

    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return best;
}

/** A node in the dependency graph: what it provides, what it needs, and where it came from. */
export interface GraphNode {
  name: string;
  needs: string[];
  provides: string[];
  origin: string;
}

/** Orders nodes so every dependency precedes its dependents; throws on missing keys or cycles. */
export function topoSort(nodes: GraphNode[], seedKeys: string[]): GraphNode[] {
  const producedBy = new Map<string, GraphNode>();
  for (const node of nodes) for (const key of node.provides) producedBy.set(key, node);

  // validate dependencies exist
  for (const node of nodes) {
    for (const key of node.needs) {
      if (!seedKeys.includes(key) && !producedBy.has(key)) {
        throw new Error(`missing dependency: ${key} needed by ${node.name}`);
      }
    }
  }

  const ordered: GraphNode[] = [];
  const state = new Map<GraphNode, 'visiting' | 'done'>();

  const visit = (node: GraphNode, trail: string[]): void => {
    const visitState = state.get(node);
    if (visitState === 'done') return;
    if (visitState === 'visiting') throw new Error(`cycle detected: ${[...trail, node.name].join(' -> ')}`);
    state.set(node, 'visiting');

    for (const key of node.needs) {
      const dependency = producedBy.get(key);
      if (dependency && dependency !== node) visit(dependency, [...trail, node.name]);
    }

    state.set(node, 'done');
    ordered.push(node);
  };

  for (const node of nodes) visit(node, []);
  return ordered;
}

/** Filters `ordered` down to the transitive closure of producers reachable from `needs`. */
export function subgraphFor(needs: string[], ordered: GraphNode[]): GraphNode[] {
  const producedBy = new Map<string, GraphNode>();
  for (const node of ordered) for (const key of node.provides) producedBy.set(key, node);
  const inClosure = new Set<GraphNode>();
  const work = [...needs];

  while (work.length) {
    const token = work.pop() as string;
    const node = producedBy.get(token);
    if (!node || inClosure.has(node)) continue; // no producer = seed/envelope; already-seen = skip
    inClosure.add(node);
    work.push(...node.needs);
  }

  return ordered.filter((node) => inClosure.has(node));
}
