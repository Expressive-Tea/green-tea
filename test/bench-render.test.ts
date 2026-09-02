import { describe, it, expect } from 'vitest';
import { aggregate } from '../bench/stats';
import { renderMarkdown } from '../bench/render';

describe('aggregate', () => {
  it('median, stddev, cv, min/max over run req/s', () => {
    const a = aggregate([100, 110, 120, 130, 140]);
    expect(a.median).toBe(120);
    expect(a.min).toBe(100);
    expect(a.max).toBe(140);
    expect(a.stddev).toBeGreaterThan(0);
    expect(a.cv).toBeCloseTo(a.stddev / a.mean, 6);
  });
});

describe('renderMarkdown', () => {
  const data = {
    env: {
      date: '2026-07-06',
      commit: 'abc123',
      node: 'v18.19.0',
      os: 'darwin',
      cpu: 'M1 (8 cores)',
      ram: '16 GB',
      pinned: false,
    },
    config: { conns: 100, duration: 10, runs: 5, warmup: 1, pipelining: 1 },
    scenarios: [
      {
        title: 'JSON hello (overhead)',
        name: 'hello',
        approximation: false,
        rows: [
          {
            framework: 'fastify',
            reqSec: { median: 50000, min: 49000, max: 51000, stddev: 700, cv: 0.014 },
            p50: 1.5,
            p99: 4,
            p999: 9,
          },
          {
            framework: 'green-tea',
            reqSec: { median: 42000, min: 41000, max: 43000, stddev: 600, cv: 0.014 },
            p50: 1.9,
            p99: 5,
            p999: 11,
          },
        ],
      },
    ],
    stepScaling: [
      { path: '/steps/0', steps: 0, reqSec: 45000 },
      { path: '/steps/3', steps: 3, reqSec: 40000 },
    ],
    secureCost: [
      { label: 'security:false (parity)', reqSec: 45000 },
      { label: 'security:true (default)', reqSec: 43000 },
    ],
  };
  it('renders env header, a per-scenario table with a row per framework, and the micro-bench sections', () => {
    const md = renderMarkdown(data as any);
    expect(md).toContain('# green-tea Benchmarks');
    expect(md).toContain('abc123'); // commit
    expect(md).toContain('single-box'); // contention caveat
    expect(md).toContain('JSON hello (overhead)');
    expect(md).toContain('fastify');
    expect(md).toContain('green-tea');
    expect(md).toMatch(/req\/s/i);
    expect(md).toContain('p99');
    expect(md).toContain('Step-scaling');
    expect(md).toContain('secure-by-default');
    expect(md).toContain('approximation'); // methodology mentions the pipeline approximation
  });
  it('sorts each scenario rows by median req/s descending', () => {
    const md = renderMarkdown(data as any);
    expect(md.indexOf('fastify')).toBeLessThan(md.indexOf('green-tea')); // fastify (50k) before green-tea (42k)
  });
});

describe('renderMarkdown runtime matrix', () => {
  const base = {
    env: { date: '2026-09-01', commit: 'abc1234', node: 'v22', os: 'darwin', cpu: 'M4', ram: '69 GB', pinned: false },
    config: { conns: 100, duration: 10, runs: 5, warmup: 1, pipelining: 1 },
    scenarios: [],
    stepScaling: [],
    secureCost: [],
  };

  it('renders one column per runtime and one row per scenario', () => {
    const md = renderMarkdown({
      ...base,
      runtimes: [
        { runtime: 'node', scenario: 'JSON hello', reqSec: 90_000 },
        { runtime: 'bun', scenario: 'JSON hello', reqSec: 120_000 },
      ],
    } as never);

    expect(md).toContain('## green-tea across runtimes');
    expect(md).toContain('| Scenario | node | bun |');
    expect(md).toContain('| JSON hello | 90,000 | 120,000 |');
  });

  it('marks a runtime that produced no number rather than printing a zero', () => {
    // A skipped runtime must not read as "it ran and scored nothing".
    const md = renderMarkdown({
      ...base,
      runtimes: [
        { runtime: 'node', scenario: 'JSON hello', reqSec: 90_000 },
        { runtime: 'deno', scenario: 'Route param', reqSec: 80_000 },
      ],
    } as never);

    expect(md).toContain('| JSON hello | 90,000 | — |');
    expect(md).toContain('| Route param | — | 80,000 |');
  });

  it('omits the section entirely when no runtime was measured', () => {
    expect(renderMarkdown({ ...base, runtimes: [] } as never)).not.toContain('across runtimes');
    expect(renderMarkdown(base as never)).not.toContain('across runtimes');
  });
});
