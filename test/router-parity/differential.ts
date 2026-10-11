/**
 * The frozen matcher differential, free of vitest and of any runtime's file API, so the same
 * comparison runs on Node (vitest), Deno, Bun and workerd. Each runtime passes a loader that
 * returns a frozen file's parsed JSON.
 *
 * It compares exactly what `matcher.test.ts` compares — regenerated inputs, oracle outputs and live
 * outputs against the frozen capture, key and array order included — and returns mismatches instead
 * of throwing, so a runner can report them all.
 */
import * as live from '../../src/http/router';
import { matchWsRoute as liveMatchWsRoute } from '../../src/http/ws-core';
import type { WsRouteDef } from '../../src/http/types';
import * as oracle from './oracle';
import { runScenario, type MatcherImpl, type Outcome, type Scenario } from './matcher';
import { HAND_SCENARIOS, OWNER_SCENARIOS } from './cases';
import { generateScenarios, generateScenariosV2, GENERATOR_SEED } from './generator';

export type FrozenLoader = (name: string) => unknown | Promise<unknown>;

interface CapturedScenario extends Scenario {
  outcomes: Outcome[];
}

// ── WebSocket matcher cases (first registered wins) ─────────────────────────────────────────────

type WsDecl = WsRouteDef & { id: string };
export type WsMatcher = (
  routes: WsRouteDef[],
  path: string,
) => { def: WsRouteDef; params: Record<string, string> | undefined } | undefined;

const ws = (id: string, pattern: string): WsDecl => ({ id, pattern, open: async () => (async function* () {})() });
const overlap = [ws('param', '/ws/:id'), ws('static', '/ws/static'), ws('rest', '/ws/:rest*')];
const WS_SCENARIOS = [
  { id: 'W01-overlap', routes: overlap },
  { id: 'W02-overlap-reversed', routes: [...overlap].reverse() },
  { id: 'W03-catch-all-first', routes: [ws('rest', '/w/:rest*'), ws('exact', '/w')] },
];
// Fed already normalized, as both upgrade adapters do since #117.
const WS_PATHS = ['/ws/static', '/ws/x', '/ws/a%20b', '/ws', '/ws/x/y', '/w', '/w/a%2Fb/c', '/nope'];

export function runWsMatcher(matchWs: WsMatcher) {
  return WS_SCENARIOS.map(({ id, routes }) => ({
    id,
    declarations: routes.map((route) => ({ id: route.id, pattern: route.pattern })),
    outcomes: WS_PATHS.map((path) => {
      const hit = matchWs(routes, path);
      return { path, route: hit ? { id: (hit.def as WsDecl).id, params: hit.params } : null };
    }),
  }));
}

export const LIVE_WS_MATCHER: WsMatcher = liveMatchWsRoute;
export const ORACLE_WS_MATCHER: WsMatcher = oracle.matchWsRoute;

// ── the comparison ──────────────────────────────────────────────────────────────────────────────

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

export interface DifferentialReport {
  sets: Array<{ name: string; scenarios: number; requests: number }>;
  mismatches: string[];
}

const SETS: Array<{ name: string; scenarios: () => Scenario[]; inFile: (data: any) => CapturedScenario[] }> = [
  { name: 'matcher-hand', scenarios: () => HAND_SCENARIOS, inFile: (data) => data },
  { name: 'matcher-owner', scenarios: () => OWNER_SCENARIOS, inFile: (data) => data },
  { name: 'matcher-generated', scenarios: () => generateScenarios(GENERATOR_SEED), inFile: (data) => data.scenarios },
  {
    name: 'matcher-generated-v2',
    scenarios: () => generateScenariosV2(GENERATOR_SEED),
    inFile: (data) => data.scenarios,
  },
];

function compareSet(name: string, scenarios: Scenario[], expected: CapturedScenario[], mismatches: string[]): number {
  const byId = new Map(expected.map((scenario) => [scenario.id, scenario]));
  if (
    !same(
      expected.map((s) => s.id),
      scenarios.map((s) => s.id),
    )
  )
    mismatches.push(`${name}: scenario ids differ from the frozen file`);

  let requests = 0;
  for (const scenario of scenarios) {
    const frozen = byId.get(scenario.id);
    if (!frozen) continue;
    const { outcomes, ...inputs } = frozen;
    requests += scenario.requests.length;
    if (!same(plain(scenario), inputs)) mismatches.push(`${name} ${scenario.id}: inputs`);
    const impls: Array<[string, MatcherImpl]> = [
      ['oracle', oracle],
      ['live', live],
    ];
    for (const [label, impl] of impls)
      if (!same(plain(runScenario(impl, scenario)), outcomes)) mismatches.push(`${name} ${scenario.id}: ${label}`);
  }
  return requests;
}

export async function runDifferential(load: FrozenLoader): Promise<DifferentialReport> {
  const mismatches: string[] = [];
  const sets: DifferentialReport['sets'] = [];

  for (const set of SETS) {
    const scenarios = set.scenarios();
    const file = (await load(set.name)) as { data: unknown };
    const requests = compareSet(set.name, scenarios, set.inFile(file.data), mismatches);
    sets.push({ name: set.name, scenarios: scenarios.length, requests });
  }

  const wsFile = (await load('matcher-ws')) as { data: unknown };
  for (const [label, matcher] of [
    ['oracle', ORACLE_WS_MATCHER],
    ['live', LIVE_WS_MATCHER],
  ] as const)
    if (!same(plain(runWsMatcher(matcher)), wsFile.data)) mismatches.push(`matcher-ws: ${label}`);
  sets.push({ name: 'matcher-ws', scenarios: WS_SCENARIOS.length, requests: WS_SCENARIOS.length * WS_PATHS.length });

  return { sets, mismatches };
}
