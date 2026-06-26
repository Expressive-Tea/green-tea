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
