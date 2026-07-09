import { describe, it, expect } from 'vitest';
import { toMermaid, toDOT, graphHtml, type GraphView } from '../src/graph-viz';

const view: GraphView = {
  nodes: [
    { name: 'db', kind: 'provider', origin: 'module:M', needs: ['config'], provides: ['db'] },
    { name: 'config', kind: 'provider', origin: 'module:M', needs: [], provides: ['config'] },
    { name: 'user', kind: 'step', origin: 'module:M', needs: ['db', 'req'], provides: ['user'] },
  ],
  routes: [{ pattern: '/users/:id', method: 'GET', transport: 'buffer', chain: ['config', 'db', 'user', 'getUser'] }],
};

describe('toMermaid', () => {
  it('declares nodes and draws needs edges between known nodes', () => {
    const m = toMermaid(view);
    expect(m).toContain('flowchart');
    expect(m).toContain('"db"');
    expect(m).toContain('"user"');
    expect(m).toContain('n_config --> n_db'); // db needs config
    expect(m).toContain('n_db --> n_user'); // user needs db
    expect(m).not.toContain('n_req'); // 'req' is a seed (no node) -> no edge
    expect(m).toContain('GET /users/:id'); // route node label
  });
});

describe('toDOT', () => {
  it('emits a digraph with nodes and edges', () => {
    const d = toDOT(view);
    expect(d).toContain('digraph');
    expect(d).toContain('"config" -> "db"');
  });
});

describe('graphHtml', () => {
  it('emits an interactive Cytoscape page with the graph embedded as JSON', () => {
    const html = graphHtml(view);
    expect(html).toContain('cytoscape'); // loads the viz lib from CDN
    expect(html).toContain('cytoscape-dagre'); // and the DAG layout
    expect(html).toContain('"user"'); // node data is embedded client-side
    expect(html).toContain('/users/:id'); // route data too
  });

  it('escapes embedded JSON so a node name cannot break out of the script tag', () => {
    const evil = graphHtml({
      nodes: [{ name: 'a</script><b', kind: 'provider', origin: 'x', needs: [], provides: ['a'] }],
      routes: [],
    });
    expect(evil).not.toContain('a</script><b'); // raw injection must not survive
    expect(evil).toContain('a\\u003c/script'); // '<' is escaped to <
  });
});
