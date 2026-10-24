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

/**
 * Maps every token to the one node that produces it; throws when a second node provides a token.
 *
 * One producer per token, across modules, plugins, mesh steps and built-ins alike (GitHub #35, D9).
 * This used to be `producedBy.set(key, node)`, last one wins: plugin nodes are registered after
 * module nodes, so a plugin's `scope.add` that provided `user` silently replaced the app's own `user`
 * for every route that needed it. Checking here, on the whole graph, rather than at each place a node
 * is registered, is what covers every path — current and future — and makes the built-in tokens
 * (`logger`, `rooms`, `events`) safe by rule instead of by registration order.
 */
function producers(nodes: GraphNode[]): Map<string, GraphNode> {
  const producedBy = new Map<string, GraphNode>();

  for (const node of nodes) {
    for (const key of node.provides) {
      const prior = producedBy.get(key);

      if (prior && prior !== node) {
        throw new Error(
          `token '${key}' is provided twice: by '${prior.name}' (${prior.origin}) and by '${node.name}' (${node.origin}) — ` +
            'a token has exactly one producer; rename one of them, or use `overrides` to replace a runner',
        );
      }

      producedBy.set(key, node);
    }
  }

  return producedBy;
}

/**
 * Orders nodes so every dependency precedes its dependents; throws on a token with two producers,
 * missing keys or cycles.
 */
export function topoSort(nodes: GraphNode[], seedKeys: string[], note = ''): GraphNode[] {
  const producedBy = producers(nodes);

  // validate dependencies exist
  for (const node of nodes) {
    for (const key of node.needs) {
      if (seedKeys.includes(key)) continue;
      const producer = producedBy.get(key);

      if (!producer) throw new Error(`missing dependency: ${key} needed by ${node.name}${note}`);

      // A node that needs its own token is a cycle of one (GitHub #43): it would read a value nobody
      // wrote yet. `producers` already allows one producer per token, so no other node can supply
      // it; only a seed makes the need real, and the seed case continued above. Same wording as the
      // cycle check below, so both read as the one error they are.
      if (producer === node) {
        throw new Error(
          `cycle detected: ${node.name} -> ${node.name} (it needs '${key}', which only it provides)${note}. ` +
            `Remove '${key}' from its needs, or move the work that produces '${key}' into a step it needs.`,
        );
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

/**
 * Groups an already topo-sorted list into dependency levels: nothing in a level can constrain
 * anything else in it, and a level depends only on the levels before it — so a level can run
 * concurrently. Needs produced by nothing in `ordered` (seeds, filtered-out kinds) constrain
 * nothing and are ignored.
 */
export function topoLevels(ordered: GraphNode[]): GraphNode[][] {
  const producedBy = new Map<string, GraphNode>();
  for (const node of ordered) for (const key of node.provides) producedBy.set(key, node);
  const depthOf = new Map<GraphNode, number>();
  const levels: GraphNode[][] = [];

  // One forward pass is enough: `ordered` is topologically sorted, so every producer of a node's
  // needs already has its depth by the time the node is reached.
  for (const node of ordered) {
    let depth = 0;

    for (const key of node.needs) {
      const producer = producedBy.get(key);
      if (producer && producer !== node) depth = Math.max(depth, (depthOf.get(producer) ?? 0) + 1);
    }

    depthOf.set(node, depth);
    (levels[depth] ??= []).push(node);
  }

  return levels;
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
