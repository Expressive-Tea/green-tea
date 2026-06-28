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
    expect(m).toContain('n_config --> n_db');   // db needs config
    expect(m).toContain('n_db --> n_user');      // user needs db
    expect(m).not.toContain('n_req');            // 'req' is a seed (no node) -> no edge
    expect(m).toContain('GET /users/:id');       // route node label
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
  it('wraps mermaid source in an HTML page that loads mermaid', () => {
    const html = graphHtml('flowchart LR\n  a-->b');
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('flowchart LR');
    expect(html).toContain('mermaid');
  });
});
