function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}

export function nearest(token: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = 3;   // only suggest edit distance <= 2
  for (const c of candidates) { const dist = levenshtein(token, c); if (dist < bestD) { bestD = dist; best = c; } }
  return best;
}

export interface GraphNode {
  name: string;
  needs: string[];
  provides: string[];
  origin: string;
}

export function topoSort(nodes: GraphNode[], seedKeys: string[]): GraphNode[] {
  const producedBy = new Map<string, GraphNode>();
  for (const n of nodes) for (const key of n.provides) producedBy.set(key, n);

  // validate dependencies exist
  for (const n of nodes) {
    for (const key of n.needs) {
      if (!seedKeys.includes(key) && !producedBy.has(key)) {
        throw new Error(`missing dependency: ${key} needed by ${n.name}`);
      }
    }
  }

  const ordered: GraphNode[] = [];
  const state = new Map<GraphNode, 'visiting' | 'done'>();

  const visit = (n: GraphNode, trail: string[]): void => {
    const s = state.get(n);
    if (s === 'done') return;
    if (s === 'visiting') throw new Error(`cycle detected: ${[...trail, n.name].join(' -> ')}`);
    state.set(n, 'visiting');
    for (const key of n.needs) {
      const dep = producedBy.get(key);
      if (dep && dep !== n) visit(dep, [...trail, n.name]);
    }
    state.set(n, 'done');
    ordered.push(n);
  };

  for (const n of nodes) visit(n, []);
  return ordered;
}

export function subgraphFor(needs: string[], ordered: GraphNode[]): GraphNode[] {
  const producedBy = new Map<string, GraphNode>();
  for (const n of ordered) for (const k of n.provides) producedBy.set(k, n);
  const inClosure = new Set<GraphNode>();
  const work = [...needs];
  while (work.length) {
    const token = work.pop() as string;
    const node = producedBy.get(token);
    if (!node || inClosure.has(node)) continue; // no producer = seed/envelope; already-seen = skip
    inClosure.add(node);
    work.push(...node.needs);
  }
  return ordered.filter((n) => inClosure.has(n));
}
