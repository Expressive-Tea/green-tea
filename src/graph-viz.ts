/** Renderable view of a graph node (provider or step). */
export interface GraphNodeView {
  name: string;
  kind: 'provider' | 'step';
  origin: string;
  needs: string[];
  provides: string[];
}
/** Renderable view of a route and the chain of nodes feeding its handler. */
export interface GraphRouteView {
  pattern: string;
  method: string;
  transport: string;
  chain: string[];
}
/** Full graph payload consumed by the diagram renderers. */
export interface GraphView {
  nodes: GraphNodeView[];
  routes: GraphRouteView[];
}

/** Sanitizes a node name into a Mermaid/DOT-safe node id. */
const nid = (name: string) => 'n_' + name.replace(/[^a-zA-Z0-9]/g, '_');
/** Sanitizes a route pattern into a Mermaid/DOT-safe node id. */
const rid = (pattern: string) => 'r_' + pattern.replace(/[^a-zA-Z0-9]/g, '_');

/** Renders the graph view as Mermaid `flowchart` source. */
export function toMermaid(view: GraphView): string {
  const known = new Set(view.nodes.map((node) => node.name));
  const out: string[] = ['flowchart LR'];

  for (const node of view.nodes) {
    out.push(
      node.kind === 'provider' ? `  ${nid(node.name)}(["${node.name}"])` : `  ${nid(node.name)}["${node.name}"]`,
    );
  }

  for (const node of view.nodes)
    for (const need of node.needs) if (known.has(need)) out.push(`  ${nid(need)} --> ${nid(node.name)}`);

  for (const route of view.routes) {
    out.push(`  ${rid(route.pattern)}{{"${route.method} ${route.pattern}"}}`);
    for (const link of route.chain) if (known.has(link)) out.push(`  ${nid(link)} --> ${rid(route.pattern)}`);
  }

  return out.join('\n');
}

/** Renders the graph view as Graphviz DOT source. */
export function toDOT(view: GraphView): string {
  const known = new Set(view.nodes.map((node) => node.name));
  const out: string[] = ['digraph green_tea {', '  rankdir=LR;'];

  for (const node of view.nodes) {
    out.push(`  "${node.name}" [shape=${node.kind === 'provider' ? 'ellipse' : 'box'}];`);
  }

  for (const node of view.nodes)
    for (const need of node.needs) if (known.has(need)) out.push(`  "${need}" -> "${node.name}";`);

  for (const route of view.routes) {
    const label = `${route.method} ${route.pattern}`;
    out.push(`  "${label}" [shape=hexagon];`);
    for (const link of route.chain) if (known.has(link)) out.push(`  "${link}" -> "${label}";`);
  }

  out.push('}');
  return out.join('\n');
}

/** Wraps Mermaid source in a self-contained HTML page that renders it in the browser. */
export function graphHtml(mermaid: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>green-tea graph</title>',
    '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></head>',
    '<body><pre class="mermaid">',
    mermaid,
    '</pre>',
    '<script>mermaid.initialize({ startOnLoad: true });</script></body></html>',
  ].join('\n');
}
