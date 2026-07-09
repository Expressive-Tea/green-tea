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

/**
 * Renders the graph as a self-contained, interactive HTML page (Cytoscape.js +
 * dagre, both from a CDN — no runtime dependency is added). Clicking a route
 * lights up its exact transitive slice and dims everything else; clicking a
 * provider/step shows its blast radius (every route that depends on it).
 *
 * The whole {@link GraphView} is embedded as JSON, so all interaction is
 * client-side — the page needs nothing from the server after it loads.
 */
export function graphHtml(view: GraphView): string {
  const data = JSON.stringify(view).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>green-tea graph</title>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js"></script>
<style>
  :root { --bg:#fff; --ink:#1c2128; --dim:#57606a; --line:#d0d7de; --tea:#7c6cf0; --panel:#f6f8fa;
    --prov:#1f9e8a; --step:#7c6cf0; --need:#2f81f7; --feed:#bf8700; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --ink:#e6edf3; --dim:#8b949e; --line:#30363d; --tea:#a78bfa; --panel:#161b22;
    --prov:#3fd0b8; --step:#a78bfa; --need:#58a6ff; --feed:#e3b341; } }
  * { box-sizing:border-box; } html,body { margin:0; height:100%; background:var(--bg); color:var(--ink);
    font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  #cy { position:absolute; inset:0; }
  #bar { position:absolute; top:0; left:0; right:0; padding:10px 14px; z-index:2; pointer-events:none;
    background:linear-gradient(var(--bg),transparent); }
  #bar b { color:var(--tea); } #bar span { color:var(--dim); }
  #legend { margin-top:6px; color:var(--dim); font-size:12px; display:flex; gap:14px; flex-wrap:wrap; }
  #legend i { display:inline-block; vertical-align:middle; margin-right:5px; }
  #legend .sw { width:11px; height:11px; border-radius:3px; border:1.5px solid; }
  #legend .prov { background:var(--panel); border-color:var(--prov); }
  #legend .step { background:var(--panel); border-color:var(--step); border-radius:0; }
  #legend .route { background:var(--tea); border-color:var(--tea); }
  #legend .ln { width:16px; height:0; border-top:3px solid; border-radius:0; }
  #legend .need { border-color:var(--need); } #legend .feed { border-color:var(--feed); }
  #legend .tp { background:transparent; border-color:var(--dim); }
  #legend .tp-http { border-style:solid; } #legend .tp-sse { border-style:dashed; }
  #legend .tp-ws { border-style:double; border-width:3px; }
  #info { position:absolute; left:14px; bottom:14px; z-index:2; max-width:340px; padding:10px 12px;
    background:var(--panel); border:1px solid var(--line); border-radius:8px; white-space:pre-wrap; display:none; }
  #info .t { color:var(--tea); font-weight:700; } #info .k { color:var(--dim); }
</style></head><body>
<div id="bar"><b>🍵 green-tea</b> · <span>click a <b>route</b> for its slice · click a <b>provider/step</b> for its blast radius · drag to rearrange · click canvas to reset</span>
<div id="legend"><span><i class="sw prov"></i>provider</span><span><i class="sw step"></i>step</span><span><i class="ln need"></i>needs</span><span><i class="ln feed"></i>feeds endpoint</span><span><i class="sw tp tp-http"></i>HTTP</span><span><i class="sw tp tp-sse"></i>SSE</span><span><i class="sw tp tp-ws"></i>WS</span></div></div>
<div id="cy"></div>
<div id="info"></div>
<script>
  var DATA = ${data};
  try { if (window.cytoscapeDagre) cytoscape.use(window.cytoscapeDagre); } catch (e) {}
  var css = getComputedStyle(document.documentElement);
  var C = function (n) { return css.getPropertyValue(n).trim(); };
  var nodeNames = new Set(DATA.nodes.map(function (n) { return n.name; }));
  var nid = function (s) { return 'n_' + s.replace(/[^a-zA-Z0-9]/g, '_'); };
  var rid = function (s) { return 'r_' + s.replace(/[^a-zA-Z0-9]/g, '_'); };

  // HTTP method -> colour, so the endpoint type is visual, not just text.
  var METHOD_COLORS = { GET: '#3fb950', POST: '#a371f7', PUT: '#d29922', PATCH: '#db61a2', DELETE: '#f85149', HEAD: '#8b949e', OPTIONS: '#8b949e' };
  var methodColor = function (m) { return METHOD_COLORS[m] || '#8b949e'; };

  var els = [];
  DATA.nodes.forEach(function (n) {
    els.push({ data: { id: nid(n.name), label: n.name, kind: n.kind, origin: n.origin,
      needs: (n.needs || []).join(', '), provides: (n.provides || []).join(', ') } });
  });
  DATA.routes.forEach(function (r) {
    var suffix = r.transport && r.transport !== 'buffer' ? '  · ' + r.transport : '';
    els.push({ data: { id: rid(r.pattern), label: r.method + ' ' + r.pattern + suffix, kind: 'route',
      method: r.method, transport: r.transport, color: methodColor(r.method) } });
  });
  DATA.nodes.forEach(function (n) {
    (n.needs || []).forEach(function (need) {
      if (nodeNames.has(need)) els.push({ data: { id: 'e' + nid(need) + nid(n.name), source: nid(need), target: nid(n.name), rel: 'need' } });
    });
  });
  DATA.routes.forEach(function (r) {
    (r.chain || []).forEach(function (name) {
      if (nodeNames.has(name)) els.push({ data: { id: 'e' + nid(name) + rid(r.pattern), source: nid(name), target: rid(r.pattern), rel: 'feed' } });
    });
  });

  // Precomputed highlight sets (uses green-tea's real per-route slice).
  var routeChain = {}; DATA.routes.forEach(function (r) {
    routeChain[rid(r.pattern)] = (r.chain || []).filter(function (x) { return nodeNames.has(x); }).map(nid);
  });
  var nodeRoutes = {}; DATA.nodes.forEach(function (n) {
    nodeRoutes[nid(n.name)] = DATA.routes.filter(function (r) { return (r.chain || []).indexOf(n.name) >= 0; })
      .map(function (r) { return rid(r.pattern); });
  });

  // Method colour chips in the legend — only for methods actually present.
  var legend = document.getElementById('legend'), seenMethod = {};
  DATA.routes.forEach(function (r) {
    if (seenMethod[r.method]) return; seenMethod[r.method] = 1;
    var s = document.createElement('span');
    s.innerHTML = '<i class="sw" style="background:' + methodColor(r.method) + ';border-color:' + methodColor(r.method) + '"></i>' + r.method;
    legend.appendChild(s);
  });

  var cy = cytoscape({
    container: document.getElementById('cy'),
    elements: els,
    style: [
      { selector: 'node', style: { 'label': 'data(label)', 'color': C('--ink'), 'font-family': 'ui-monospace,Menlo,monospace',
        'font-size': 12, 'text-valign': 'center', 'text-halign': 'center', 'width': 'label', 'height': 'label',
        'padding': '10px', 'background-color': C('--panel'), 'border-width': 1.5, 'border-color': C('--tea'), 'shape': 'round-rectangle' } },
      { selector: 'node[kind = "provider"]', style: { 'shape': 'round-rectangle', 'background-color': C('--panel'), 'border-color': C('--prov') } },
      { selector: 'node[kind = "step"]', style: { 'shape': 'rectangle', 'border-color': C('--step') } },
      { selector: 'node[kind = "route"]', style: { 'shape': 'round-rectangle', 'background-color': 'data(color)', 'color': '#fff', 'border-width': 1.5, 'border-color': '#fff', 'border-style': 'solid', 'font-weight': 'bold' } },
      { selector: 'node[transport = "sse"]', style: { 'border-style': 'dashed', 'border-width': 2.5 } },
      { selector: 'node[transport = "negotiate"]', style: { 'border-style': 'dotted', 'border-width': 2.5 } },
      { selector: 'node[transport = "ws"]', style: { 'border-style': 'double', 'border-width': 4 } },
      { selector: 'edge', style: { 'width': 1, 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.75 } },
      { selector: 'edge[rel = "need"]', style: { 'line-color': C('--need'), 'target-arrow-color': C('--need') } },
      { selector: 'edge[rel = "feed"]', style: { 'line-color': C('--feed'), 'target-arrow-color': C('--feed') } },
      { selector: '.dim', style: { 'opacity': 0.1 } },
      { selector: 'node.hot', style: { 'border-width': 3 } },
      { selector: 'edge.hot', style: { 'width': 1.9, 'opacity': 1 } }
    ]
  });

  var layout = { name: 'dagre', rankDir: 'LR', nodeSep: 36, rankSep: 90, edgeSep: 12 };
  try { cy.layout(layout).run(); } catch (e) { cy.layout({ name: 'breadthfirst', directed: true }).run(); }

  function highlight(idSet) {
    cy.batch(function () {
      cy.elements().removeClass('hot').addClass('dim');
      idSet.forEach(function (id) { cy.getElementById(id).removeClass('dim').addClass('hot'); });
      cy.edges().forEach(function (e) {
        if (idSet.has(e.source().id()) && idSet.has(e.target().id())) e.removeClass('dim').addClass('hot');
      });
    });
  }
  function reset() { cy.batch(function () { cy.elements().removeClass('dim hot'); }); }

  var info = document.getElementById('info');
  function showInfo(el) {
    var k = el.data('kind');
    var body = k === 'route'
      ? '<span class="k">' + el.data('transport') + ' route</span>'
      : '<span class="k">kind</span> ' + k + '\\n<span class="k">needs</span> ' + (el.data('needs') || '—')
        + '\\n<span class="k">provides</span> ' + (el.data('provides') || '—')
        + '\\n<span class="k">origin</span> ' + (el.data('origin') || '—');
    info.style.display = 'block';
    info.innerHTML = '<span class="t">' + el.data('label') + '</span>\\n' + body;
  }

  cy.on('tap', 'node', function (evt) {
    var el = evt.target, id = el.id();
    var ids = el.data('kind') === 'route'
      ? new Set([id].concat(routeChain[id] || []))
      : new Set([id].concat(nodeRoutes[id] || []));
    highlight(ids);
    showInfo(el);
  });
  cy.on('mouseover', 'node', function (evt) { showInfo(evt.target); });
  cy.on('tap', function (evt) { if (evt.target === cy) { reset(); info.style.display = 'none'; } });
</script></body></html>`;
}
