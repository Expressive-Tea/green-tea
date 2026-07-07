export interface EnvInfo {
  date: string;
  commit: string;
  node: string;
  os: string;
  cpu: string;
  ram: string;
  pinned: boolean;
}

export interface Config {
  conns: number;
  duration: number;
  runs: number;
  warmup: number;
  pipelining: number;
}

export interface Row {
  framework: string;
  reqSec: { median: number; min: number; max: number; stddev: number; cv: number };
  p50: number;
  p99: number;
  p999: number;
}

export interface ScenarioBlock {
  title: string;
  name: string;
  approximation?: boolean;
  rows: Row[];
}

export interface RenderData {
  env: EnvInfo;
  config: Config;
  scenarios: ScenarioBlock[];
  stepScaling: { path: string; steps: number; reqSec: number }[];
  secureCost: { label: string; reqSec: number }[];
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');
const fmtLatency = (n: number): string => n.toFixed(2);
const fmtCv = (n: number): string => `${(n * 100).toFixed(1)}%`;
const fmtRange = (min: number, max: number): string => `${fmtInt(min)}–${fmtInt(max)}`;

function renderEnvSection(env: EnvInfo, config: Config): string {
  return [
    '## Environment',
    '',
    `- **Date**: ${env.date}`,
    `- **Commit**: ${env.commit}`,
    `- **Node**: ${env.node}`,
    `- **OS**: ${env.os}`,
    `- **CPU**: ${env.cpu}`,
    `- **RAM**: ${env.ram}`,
    `- **Core-pinned**: ${env.pinned ? 'yes' : 'no'}`,
    `- **autocannon config**: ${config.conns} connections, ${config.duration}s duration, ` +
      `${config.runs} runs (${config.warmup} warmup discarded), pipelining ${config.pipelining}`,
    '',
  ].join('\n');
}

function renderCaveat(): string {
  return [
    '> **A note on honesty: this is a single-box benchmark.** All frameworks were driven with autocannon over',
    '> loopback on the same machine, sharing the same cores as the server processes they measured. That',
    "> contention overstates absolute throughput for every framework and compresses the differences *between*",
    '> frameworks — do not read the raw req/s numbers as what you would see on separate client/server hardware.',
    '> The honest takeaway is the **ratio** between frameworks in the same table, not any single absolute',
    '> number. Note also that green-tea runs with `security:false` in the cross-framework tables below, purely',
    '> for response-header parity with the other frameworks (none of which set the same security headers by',
    '> default) — the real cost of running green-tea secure-by-default is measured separately in its own',
    '> section further down.',
    '',
  ].join('\n');
}

function renderScenarioTable(rows: Row[]): string {
  const sorted = [...rows].sort((a, b) => b.reqSec.median - a.reqSec.median);
  const header = '| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |';
  const divider = '| --- | --- | --- | --- | --- | --- | --- |';
  const lines = sorted.map((row) => {
    const { framework, reqSec, p50, p99, p999 } = row;
    return (
      `| ${framework} | ${fmtInt(reqSec.median)} | ${fmtLatency(p50)} | ${fmtLatency(p99)} | ` +
      `${fmtLatency(p999)} | ${fmtCv(reqSec.cv)} | ${fmtRange(reqSec.min, reqSec.max)} |`
    );
  });
  return [header, divider, ...lines].join('\n');
}

function renderScenarios(scenarios: ScenarioBlock[]): string {
  return scenarios
    .map((scenario) => {
      const heading = `### ${scenario.title}${scenario.approximation ? ' (approximation)' : ''}`;
      return [heading, '', renderScenarioTable(scenario.rows), ''].join('\n');
    })
    .join('\n');
}

function renderStepScaling(stepScaling: RenderData['stepScaling']): string {
  const sorted = [...stepScaling].sort((a, b) => a.steps - b.steps);
  const header = '| Path | Steps | req/s |';
  const divider = '| --- | --- | --- |';
  const lines = sorted.map((row) => `| ${row.path} | ${row.steps} | ${fmtInt(row.reqSec)} |`);

  let deltaNote = '';
  if (sorted.length >= 2) {
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const stepDiff = last.steps - first.steps;
    if (stepDiff > 0) {
      const reqDiff = last.reqSec - first.reqSec;
      const perStep = reqDiff / stepDiff;
      const pct = first.reqSec ? (reqDiff / first.reqSec) * 100 : 0;
      deltaNote =
        `Each additional pipeline step costs roughly ${fmtInt(Math.abs(perStep))} req/s ` +
        `(${pct <= 0 ? '-' : ''}${Math.abs(pct).toFixed(1)}% over ${stepDiff} step${stepDiff === 1 ? '' : 's'}), ` +
        `on this box.`;
    }
  }

  return ['## Step-scaling (green-tea)', '', header, divider, ...lines, '', deltaNote, ''].join('\n');
}

function renderSecureCost(secureCost: RenderData['secureCost']): string {
  const header = '| Label | req/s |';
  const divider = '| --- | --- |';
  const lines = secureCost.map((row) => `| ${row.label} | ${fmtInt(row.reqSec)} |`);

  let deltaNote = '';
  if (secureCost.length >= 2) {
    const baseline = secureCost[0];
    const withSecurity = secureCost[secureCost.length - 1];
    const reqDiff = baseline.reqSec - withSecurity.reqSec;
    const pct = baseline.reqSec ? (reqDiff / baseline.reqSec) * 100 : 0;
    deltaNote = `The real cost of running secure-by-default (rather than the parity-mode \`security:false\` used above) is ~${pct.toFixed(1)}% req/s on this box.`;
  }

  return [
    '## Cost of secure-by-default (green-tea)',
    '',
    header,
    divider,
    ...lines,
    '',
    deltaNote,
    '',
    '> Scope: this micro-bench currently measures the security-**headers** cost only (`security:false` vs',
    '> `security:true` on `/hello`). The incremental cost of `@body` validation and CORS is not separately',
    '> measured yet (deferred) — so this table is narrower than the design spec\'s 4-point plan.',
    '',
  ].join('\n');
}

function renderMethodology(): string {
  return [
    '## Methodology',
    '',
    '- **Parity controls**: every framework is configured for the fairest possible comparison —',
    '  security-header parity (matching header sets across frameworks, or green-tea running with',
    '  `security:false` in the cross-framework tables), keep-alive parity, and Express\'s `etag` and',
    "  `x-powered-by` disabled. The `/validate` scenario always sends a valid body so every framework",
    '  takes its success path and performs equivalent validation work.',
    '- **Pipeline approximation**: scenarios marked `(approximation)` (e.g. the multi-step pipeline route)',
    "  do not have an exact one-to-one equivalent in every framework; the closest reasonable approximation",
    '  is used for each framework and the result should be read as indicative, not as an exact apples-to-apples',
    '  measurement.',
    '- **Serialization parity**: all four frameworks serialize their JSON responses with plain',
    '  `JSON.stringify` in these benchmarks. Fastify\'s `fast-json-stringify` response serializer is',
    '  deliberately **not** engaged — only its input `schema.body` validation is used — so no framework',
    '  gets a serialization fast path the others lack.',
    '- **Content-type charset asymmetry (disclosed, not controlled)**: green-tea and raw-http send',
    '  `Content-Type: application/json` while Express and Fastify send `application/json; charset=utf-8`.',
    '  This is a minor header-byte asymmetry that is disclosed here rather than normalized away.',
    '- **NestJS runs on an underlying adapter** (Express or Fastify): the `nestjs-express` / `nestjs-fastify`',
    "  rows measure Nest's DI / decorator / routing overhead **on top of** that adapter, so compare each",
    '  against its own base (`express` / `fastify`) rather than against the field. Nest\'s idiomatic',
    '  `ValidationPipe` / class-validator is **not** used — `/validate` performs the same manual field check',
    '  as every other server (parity). The same parity controls apply: `etag` and `x-powered-by` are disabled',
    '  on the underlying Express instance, and `keepAliveTimeout` is 5000 on both adapters.',
    '',
  ].join('\n');
}

function renderLeaderboard(scenarios: ScenarioBlock[]): string {
  const first = scenarios[0];
  if (!first || first.rows.length === 0) return '';
  const leader = [...first.rows].sort((a, b) => b.reqSec.median - a.reqSec.median)[0];
  return [
    `> **TL;DR**: \`${leader.framework}\` posted the highest median req/s in the first benchmarked scenario ` +
      `on this box — see the single-box caveat below before reading anything into the absolute numbers.`,
    '',
  ].join('\n');
}

export function renderMarkdown(data: RenderData): string {
  const { env, config, scenarios, stepScaling, secureCost } = data;

  return [
    renderLeaderboard(scenarios),
    '# green-tea Benchmarks',
    '',
    renderEnvSection(env, config),
    renderCaveat(),
    '## Cross-framework scenarios',
    '',
    renderScenarios(scenarios),
    renderStepScaling(stepScaling),
    renderSecureCost(secureCost),
    renderMethodology(),
  ].join('\n');
}
