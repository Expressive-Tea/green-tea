/**
 * Differential matcher parity (CARD-08 → CARD-07, #109).
 *
 * Every scenario runs through the frozen oracle and through the live `src/http/router` exports, and
 * both must equal the outputs captured at the pinned revision. Today the live router *is* the
 * linear matcher, so this proves the oracle is a faithful copy; once CARD-07 swaps the internals
 * for a radix index behind the same exports, the same test compares oracle against radix with no
 * edit here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as live from '../../src/http/router';
import { matchWsRoute as liveMatchWsRoute } from '../../src/http/ws-core';
import type { WsRouteDef } from '../../src/http/types';
import * as oracle from './oracle';
import { runScenario, type MatcherImpl, type Outcome, type Scenario } from './matcher';
import { HAND_SCENARIOS } from './cases';
import { generateScenarios, GENERATOR_RULES, GENERATOR_SEED, GENERATOR_VERSION } from './generator';
import { frozen, expectFrozenEqual } from './frozen';

const LIVE: MatcherImpl = live;
const ORACLE: MatcherImpl = oracle;

interface CapturedScenario extends Scenario {
  outcomes: Outcome[];
}

interface GeneratedFile {
  generator: string;
  seed: number;
  rules: string[];
  scenarios: CapturedScenario[];
}

const capture = (scenarios: Scenario[]): CapturedScenario[] =>
  scenarios.map((scenario) => ({ ...scenario, outcomes: runScenario(LIVE, scenario) }));

function checkScenario(scenario: Scenario, expected: CapturedScenario | undefined): void {
  expect(expected, `${scenario.id} is missing from the frozen fixture`).toBeDefined();
  const { outcomes, ...inputs } = expected!;
  expectFrozenEqual(scenario, inputs, `${scenario.id} inputs`);
  expectFrozenEqual(runScenario(ORACLE, scenario), outcomes, `${scenario.id} oracle`);
  expectFrozenEqual(runScenario(LIVE, scenario), outcomes, `${scenario.id} live router`);
}

describe('router parity: hand-picked matcher cases', () => {
  let expected: Map<string, CapturedScenario>;

  beforeAll(async () => {
    const data = await frozen('matcher-hand', () => capture(HAND_SCENARIOS));
    expect(data.map((scenario) => scenario.id)).toEqual(HAND_SCENARIOS.map((scenario) => scenario.id));
    expected = new Map(data.map((scenario) => [scenario.id, scenario]));
  });

  for (const scenario of HAND_SCENARIOS) {
    it(`${scenario.id}: ${scenario.note}`, () => checkScenario(scenario, expected.get(scenario.id)));
  }
});

describe(`router parity: generated matcher cases (${GENERATOR_VERSION}, seed ${GENERATOR_SEED})`, () => {
  const generated = generateScenarios(GENERATOR_SEED);
  let expected: Map<string, CapturedScenario>;

  beforeAll(async () => {
    const data = await frozen<GeneratedFile>('matcher-generated', () => ({
      generator: GENERATOR_VERSION,
      seed: GENERATOR_SEED,
      rules: GENERATOR_RULES,
      scenarios: capture(generated),
    }));
    expect({ generator: data.generator, seed: data.seed, rules: data.rules }).toEqual({
      generator: GENERATOR_VERSION,
      seed: GENERATOR_SEED,
      rules: GENERATOR_RULES,
    });
    expect(data.scenarios.map((scenario) => scenario.id)).toEqual(generated.map((scenario) => scenario.id));
    expected = new Map(data.scenarios.map((scenario) => [scenario.id, scenario]));
  });

  for (const scenario of generated) {
    it(`${scenario.id}`, () => checkScenario(scenario, expected.get(scenario.id)));
  }
});

describe('router parity: WebSocket matcher (first registered wins)', () => {
  // WS selection is a separate contract from HTTP: no specificity ranking, registration order only.
  // Paths are fed already normalized, as both upgrade adapters do since #117.
  type WsDecl = WsRouteDef & { id: string };
  type WsMatcher = (
    routes: WsRouteDef[],
    path: string,
  ) => { def: WsRouteDef; params: Record<string, string> | undefined } | undefined;
  const ws = (id: string, pattern: string): WsDecl => ({ id, pattern, open: async () => (async function* () {})() });
  const overlap = [ws('param', '/ws/:id'), ws('static', '/ws/static'), ws('rest', '/ws/:rest*')];
  const scenarios = [
    { id: 'W01-overlap', routes: overlap },
    { id: 'W02-overlap-reversed', routes: [...overlap].reverse() },
    { id: 'W03-catch-all-first', routes: [ws('rest', '/w/:rest*'), ws('exact', '/w')] },
  ];
  const paths = ['/ws/static', '/ws/x', '/ws/a%20b', '/ws', '/ws/x/y', '/w', '/w/a%2Fb/c', '/nope'];

  const run = (matchWs: WsMatcher) =>
    scenarios.map(({ id, routes }) => ({
      id,
      declarations: routes.map((route) => ({ id: route.id, pattern: route.pattern })),
      outcomes: paths.map((path) => {
        const hit = matchWs(routes, path);
        return { path, route: hit ? { id: (hit.def as WsDecl).id, params: hit.params } : null };
      }),
    }));

  it('oracle and live matchWsRoute equal the frozen capture', async () => {
    const expected = await frozen('matcher-ws', () => run(liveMatchWsRoute));
    expectFrozenEqual(run(oracle.matchWsRoute), expected, 'ws oracle');
    expectFrozenEqual(run(liveMatchWsRoute), expected, 'ws live');
  });
});
