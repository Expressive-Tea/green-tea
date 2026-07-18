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
/** The Green Tea. mark (leaf whose venation is a dependency graph), inlined for the dev graph header. */
const BRAND_LOGO =
  '<svg viewBox="0 0 611 620" fill="none" aria-hidden="true"> <path d="M0 0 C6.4 4.22 7.06 11.7 8.6 18.74 C9.17 21.55 9.71 24.37 10.23 27.2 C10.43 28.25 10.63 29.3 10.84 30.39 C11.48 33.82 12.12 37.25 12.75 40.69 C12.86 41.28 12.86 41.28 13.41 44.27 C19.74 78.61 25.24 113.17 28 148 C28.1 149.25 28.2 150.5 28.31 151.78 C33.71 219.69 29.07 297.74 -17 352 C-37.58 376.04 -63.34 393.66 -92.79 405.14 C-94.83 405.93 -96.85 406.75 -98.87 407.58 C-119.07 415.67 -140.54 420.66 -162 424 C-163.26 424.2 -164.52 424.4 -165.82 424.6 C-213.88 431.88 -265.63 431.11 -313 420 C-313.8 419.81 -314.6 419.63 -315.42 419.43 C-321.96 417.87 -328.02 416.17 -334 413 C-333.4 408.16 -331.32 404.45 -329 400.25 C-328.63 399.57 -328.26 398.88 -327.88 398.18 C-325.16 393.16 -325.16 393.16 -324 392 C-316.45 391.5 -309.28 393.04 -301.88 394.38 C-266.77 400.41 -230.41 401.2 -195 397 C-193.89 396.88 -192.78 396.75 -191.63 396.63 C-143.03 391.12 -90.07 376.55 -53 343 C-52.13 342.26 -51.26 341.53 -50.37 340.77 C-13.69 309.26 -0.6 260.49 3 214 C6.89 162.68 1.22 110.21 -9.66 60.01 C-10 58 -10 58 -10 54 C-10.66 54 -11.32 54 -12 54 C-12.08 54.65 -12.16 55.3 -12.24 55.98 C-13.28 60.13 -15.18 63.61 -17.19 67.38 C-17.63 68.2 -18.06 69.02 -18.51 69.87 C-27.46 86.43 -37.3 102.24 -49 117 C-49.73 117.94 -50.46 118.88 -51.21 119.85 C-55.22 124.97 -59.47 129.83 -63.85 134.63 C-65.75 136.73 -67.6 138.85 -69.44 141 C-76.06 148.56 -83.19 155.34 -91.04 161.6 C-93.13 163.29 -95.16 165 -97.18 166.77 C-122.17 188.79 -151.25 205.29 -180.04 221.76 C-192.95 229.14 -205.58 236.83 -218 245 C-218.85 245.56 -219.7 246.12 -220.58 246.7 C-229.87 252.82 -238.77 259.13 -247.12 266.49 C-249.7 268.74 -252.35 270.84 -255.06 272.94 C-267.05 282.7 -278.61 294.17 -288.03 306.45 C-289.89 308.86 -291.81 311.22 -293.74 313.57 C-298.14 319.07 -302.07 324.81 -305.94 330.69 C-306.64 331.75 -307.34 332.82 -308.07 333.91 C-310.06 336.94 -312.03 339.97 -314 343 C-314.45 343.69 -314.9 344.38 -315.36 345.1 C-333.78 373.72 -347.37 405.97 -360.01 437.47 C-367.19 455.23 -367.19 455.23 -373 459 C-381.02 461.67 -388.52 459.36 -396 456 C-400.94 452.9 -406.06 449.11 -409 444 C-409.81 440.26 -409.56 438.01 -407.71 434.64 C-404.3 429.62 -400.39 425.15 -396.3 420.68 C-391.69 415.32 -387.56 409.58 -383.38 403.88 C-382.15 402.21 -380.9 400.55 -379.64 398.89 C-379 398.02 -378.35 397.15 -377.69 396.25 C-377.13 395.51 -376.58 394.78 -376.01 394.02 C-375 392 -375 392 -375.3 390.07 C-376.44 386.69 -378.78 384.1 -380.94 381.31 C-403.08 351.79 -416.04 315.59 -420 279 C-420.11 278.07 -420.22 277.14 -420.34 276.18 C-425.19 227.03 -413.92 174.12 -382.44 135.12 C-380.97 133.41 -379.49 131.7 -378 130 C-377.28 129.17 -376.56 128.34 -375.82 127.49 C-358.11 107.42 -337.64 91.46 -314 79 C-313.38 78.67 -312.76 78.33 -312.12 77.99 C-300.18 71.58 -287.7 66.68 -275 62 C-274.14 61.68 -273.29 61.36 -272.4 61.03 C-234.24 47.03 -193.39 42.56 -153.28 37.74 C-131.4 35.11 -109.62 32.33 -88 28 C-87.42 27.89 -87.42 27.89 -84.51 27.32 C-61.65 22.81 -40.27 14.77 -19.21 4.91 C-6.48 -0.98 -6.48 -0.98 0 0 Z M-36.19 37.49 C-71.76 55.45 -113.52 58.93 -152.55 63.46 C-196.61 68.6 -196.61 68.6 -216 73 C-217 73.22 -218 73.43 -219.03 73.65 C-264.38 83.45 -306.87 101.06 -341 133 C-341.95 133.88 -342.9 134.77 -343.88 135.68 C-373.91 164.27 -390.12 205.53 -391.38 246.65 C-392.35 288.29 -383.46 327.6 -361 363 C-358.84 360.25 -357.1 357.49 -355.47 354.39 C-354.99 353.5 -354.52 352.61 -354.03 351.69 C-353.78 351.21 -353.78 351.21 -352.5 348.81 C-342.16 329.63 -330.05 311.66 -316 295 C-315.08 293.89 -314.16 292.78 -313.24 291.68 C-308.88 286.45 -304.51 281.32 -299.6 276.6 C-297.85 274.85 -296.28 273.01 -294.69 271.12 C-278.78 252.73 -256.54 237.48 -235.78 225.07 C-233.06 223.44 -230.38 221.74 -227.69 220.06 C-219.23 214.87 -210.61 209.95 -202 205 C-193.33 200.01 -184.66 195.01 -176 190 C-174.99 189.42 -173.99 188.84 -172.95 188.24 C-161.6 181.67 -150.51 174.92 -139.83 167.3 C-137.99 165.99 -136.14 164.7 -134.29 163.41 C-123.48 155.83 -113.46 147.55 -103.79 138.57 C-101.47 136.44 -99.13 134.36 -96.75 132.31 C-89.94 126.39 -83.79 119.91 -78 113 C-77.55 112.46 -77.1 111.93 -76.64 111.38 C-57.15 88.05 -39.86 63.1 -28 35 C-31.34 35 -33.25 36 -36.19 37.49 Z " fill="#5FB88A" transform="translate(501,80)"/> <g stroke="#5FB88A" stroke-width="12" stroke-linecap="round" fill="none"> <path d="M277 312 Q255 263 221 247"/> <path d="M338 276 Q382 305 393 340"/> <path d="M366 258 Q348 214 317 200"/> <path d="M443 186 Q469 204 475 224"/> </g> <g fill="#5FB88A"> <circle cx="221" cy="247" r="13"/> <circle cx="393" cy="340" r="13"/> <circle cx="475" cy="224" r="11"/> </g> <circle cx="317" cy="200" r="18" fill="#7C6CF0"/> </svg>';

export function graphHtml(view: GraphView): string {
  const data = JSON.stringify(view).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>green-tea graph</title>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@700&display=swap" rel="stylesheet">
<style>
  :root { --bg:#fff; --ink:#1c2128; --dim:#57606a; --line:#d0d7de; --tea:#7c6cf0; --panel:#f6f8fa;
    --matcha:#3fa873; --prov:#1f9e8a; --step:#7c6cf0; --need:#2f81f7; --feed:#bf8700; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --ink:#e6edf3; --dim:#8b949e; --line:#30363d; --tea:#a78bfa; --panel:#161b22;
    --matcha:#5fb88a; --prov:#3fd0b8; --step:#a78bfa; --need:#58a6ff; --feed:#e3b341; } }
  * { box-sizing:border-box; } html,body { margin:0; height:100%; background:var(--bg); color:var(--ink);
    font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  #cy { position:absolute; inset:0; }
  #bar { position:absolute; top:0; left:0; right:0; padding:10px 14px; z-index:2; pointer-events:none;
    background:linear-gradient(var(--bg),transparent); }
  #bar b { color:var(--tea); } #bar span { color:var(--dim); }
  #bar .brand { display:flex; align-items:center; gap:9px; margin-bottom:5px; }
  #bar .brand svg { height:27px; width:auto; }
  #bar .brand .wm { font-family:'Zen Maru Gothic',sans-serif; font-weight:700; font-size:18px; color:var(--matcha); }
  #bar .brand .wm .dot { color:var(--step); }
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
<div id="bar"><div class="brand">${BRAND_LOGO}<span class="wm">Green Tea<span class="dot">.</span></span></div><span>click a <b>route</b> for its slice · click a <b>provider/step</b> for its blast radius · drag to rearrange · click canvas to reset</span>
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
