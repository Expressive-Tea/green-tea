/**
 * Differential matcher parity (CARD-08 → CARD-07, #109).
 *
 * Every scenario runs through the frozen oracle and through the live `src/http/router` exports, and
 * both must equal the outputs captured at the pinned revision. Today the live router *is* the
 * linear matcher, so this proves the oracle is a faithful copy; once CARD-07 swaps the internals
 * for a radix index behind the same exports, the same test compares oracle against radix with no
 * edit here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import * as live from '../../src/http/router';
import * as oracle from './oracle';
import { runScenario, type MatcherImpl, type Outcome, type Scenario } from './matcher';
import { HAND_SCENARIOS, OWNER_SCENARIOS } from './cases';
import { branchStats, type BranchStats } from './branches';
import {
  generateScenarios,
  generateScenariosV2,
  GENERATOR_RULES,
  GENERATOR_SEED,
  GENERATOR_VERSION,
  GENERATOR_V2_RULES,
  GENERATOR_V2_VERSION,
} from './generator';
import { frozen, expectFrozenEqual } from './frozen';
import { runDifferential, runWsMatcher, LIVE_WS_MATCHER, ORACLE_WS_MATCHER } from './differential';

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

describe('router parity: owner-requested matcher cases', () => {
  let expected: Map<string, CapturedScenario>;

  beforeAll(async () => {
    const data = await frozen('matcher-owner', () => capture(OWNER_SCENARIOS));
    expect(data.map((scenario) => scenario.id)).toEqual(OWNER_SCENARIOS.map((scenario) => scenario.id));
    expected = new Map(data.map((scenario) => [scenario.id, scenario]));
  });

  for (const scenario of OWNER_SCENARIOS) {
    it(`${scenario.id}: ${scenario.note}`, () => checkScenario(scenario, expected.get(scenario.id)));
  }
});

interface GeneratedV2File extends GeneratedFile {
  /** Share of generated requests that walk into sibling branches; v1's share is kept for contrast. */
  branchStats: { v1: BranchStats; v2: BranchStats };
}

describe(`router parity: generated shared-prefix cases (${GENERATOR_V2_VERSION}, seed ${GENERATOR_SEED})`, () => {
  const generated = generateScenariosV2(GENERATOR_SEED);
  const stats = () => ({ v1: branchStats(generateScenarios(GENERATOR_SEED)), v2: branchStats(generated) });
  let expected: Map<string, CapturedScenario>;

  beforeAll(async () => {
    const data = await frozen<GeneratedV2File>('matcher-generated-v2', () => ({
      generator: GENERATOR_V2_VERSION,
      seed: GENERATOR_SEED,
      rules: GENERATOR_V2_RULES,
      branchStats: stats(),
      scenarios: capture(generated),
    }));
    expect({ generator: data.generator, seed: data.seed, rules: data.rules }).toEqual({
      generator: GENERATOR_V2_VERSION,
      seed: GENERATOR_SEED,
      rules: GENERATOR_V2_RULES,
    });
    expect(stats()).toEqual(data.branchStats);
    expect(data.scenarios.map((scenario) => scenario.id)).toEqual(generated.map((scenario) => scenario.id));
    expected = new Map(data.scenarios.map((scenario) => [scenario.id, scenario]));
  });

  for (const scenario of generated) {
    it(`${scenario.id}`, () => checkScenario(scenario, expected.get(scenario.id)));
  }
});

describe('router parity: WebSocket matcher (first registered wins)', () => {
  // WS selection is a separate contract from HTTP: no specificity ranking, registration order only.
  it('oracle and live matchWsRoute equal the frozen capture', async () => {
    const expected = await frozen('matcher-ws', () => runWsMatcher(LIVE_WS_MATCHER));
    expectFrozenEqual(runWsMatcher(ORACLE_WS_MATCHER), expected, 'ws oracle');
    expectFrozenEqual(runWsMatcher(LIVE_WS_MATCHER), expected, 'ws live');
  });
});

describe('router parity: runtime-neutral differential (the one Deno, Bun and workerd run)', () => {
  it('reports no mismatch on Node', async () => {
    const dir = join(__dirname, 'frozen');
    const report = await runDifferential((name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')));
    expect(report.mismatches).toEqual([]);
  });
});
