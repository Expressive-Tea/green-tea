export interface GraphNodeView { name: string; kind: 'provider' | 'step'; origin: string; needs: string[]; provides: string[] }
export interface GraphRouteView { pattern: string; method: string; transport: string; chain: string[] }
export interface GraphView { nodes: GraphNodeView[]; routes: GraphRouteView[] }

const nid = (s: string) => 'n_' + s.replace(/[^a-zA-Z0-9]/g, '_');
const rid = (s: string) => 'r_' + s.replace(/[^a-zA-Z0-9]/g, '_');

export function toMermaid(view: GraphView): string {
  const known = new Set(view.nodes.map((n) => n.name));
  const out: string[] = ['flowchart LR'];
  for (const n of view.nodes) {
    out.push(n.kind === 'provider' ? `  ${nid(n.name)}(["${n.name}"])` : `  ${nid(n.name)}["${n.name}"]`);
  }
  for (const n of view.nodes) for (const need of n.needs) if (known.has(need)) out.push(`  ${nid(need)} --> ${nid(n.name)}`);
  for (const r of view.routes) {
    out.push(`  ${rid(r.pattern)}{{"${r.method} ${r.pattern}"}}`);
    for (const c of r.chain) if (known.has(c)) out.push(`  ${nid(c)} --> ${rid(r.pattern)}`);
  }
  return out.join('\n');
}

export function toDOT(view: GraphView): string {
  const known = new Set(view.nodes.map((n) => n.name));
  const out: string[] = ['digraph green_tea {', '  rankdir=LR;'];
  for (const n of view.nodes) {
    out.push(`  "${n.name}" [shape=${n.kind === 'provider' ? 'ellipse' : 'box'}];`);
  }
  for (const n of view.nodes) for (const need of n.needs) if (known.has(need)) out.push(`  "${need}" -> "${n.name}";`);
  for (const r of view.routes) {
    const label = `${r.method} ${r.pattern}`;
    out.push(`  "${label}" [shape=hexagon];`);
    for (const c of r.chain) if (known.has(c)) out.push(`  "${c}" -> "${label}";`);
  }
  out.push('}');
  return out.join('\n');
}

export function graphHtml(mermaid: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>green-tea graph</title>',
    '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></head>',
    '<body><pre class="mermaid">', mermaid, '</pre>',
    '<script>mermaid.initialize({ startOnLoad: true });</script></body></html>',
  ].join('\n');
}
