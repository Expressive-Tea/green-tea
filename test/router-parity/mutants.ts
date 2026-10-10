/**
 * Mutation check for the router-parity corpus: does it catch the bugs a radix rewrite is likely to
 * introduce? Each mutant is one targeted edit to a *temporary copy* of `src/`. The parity suite runs
 * against that copy, and the mutant is killed if any test fails.
 *
 *   npm run parity:mutants
 *
 * Not part of `npm test`: it runs the suite once per mutant. `src/` in this checkout is never
 * written; the run ends by checking `git diff --exit-code src` to prove it.
 *
 * Every mutant's search text must be found exactly once, so a refactor that moves the code fails
 * loudly instead of silently testing an unmutated copy. CARD-07 replaces this matcher, so after it
 * lands these mutants describe the old code. The kill table recorded in the PR is the evidence for
 * the corpus as frozen; mutants against the new code belong to CARD-07.
 */
import { spawnSync, execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import { join, resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');

interface Mutant {
  id: string;
  models: string;
  file: string;
  from: string;
  to: string;
}

const ROUTER = 'src/http/router.ts';

export const MUTANTS: Mutant[] = [
  {
    id: 'no-backtrack',
    models: 'no backtracking to a param branch once a static first segment was entered',
    file: ROUTER,
    from: `    const params = matchCompiled(compiled, pathSegs, decoded);
    if (params) return { params, def };`,
    to: `    const params = matchCompiled(compiled, pathSegs, decoded);
    if (params) return { params, def };
    const first = compiled.segments[0];
    if (compiled.segments.length > 1 && first?.kind === 'static' && first.value === pathSegs[0]) return undefined;`,
  },
  {
    id: 'precedence-swapped',
    models: 'static and plain-param precedence swapped',
    file: ROUTER,
    from: `.map((segment) => (segment.kind === 'static' ? 3 : segment.constraint ? 2 : 1)),`,
    to: `.map((segment) => (segment.kind === 'static' ? 1 : segment.constraint ? 2 : 3)),`,
  },
  {
    id: 'tie-last-registered',
    models: 'equal-rank tie broken by the last-registered declaration',
    file: ROUTER,
    from: `for (const bucket of byMethod.values()) bucket.sort((a, b) => moreSpecific(b.compiled, a.compiled));`,
    to: `for (const bucket of byMethod.values()) bucket.reverse().sort((a, b) => moreSpecific(b.compiled, a.compiled));`,
  },
  {
    id: 'constraint-ignored',
    models: 'param constraint not tested during lookup',
    file: ROUTER,
    from: `    if (segment.constraint && !segment.constraint.test(value)) return undefined;\n`,
    to: ``,
  },
  {
    id: 'decode-before-split',
    models: 'path decoded before splitting, so %2F becomes a separator',
    file: ROUTER,
    from: `  return path.split('/').filter(Boolean);`,
    to: `  return decodeURIComponent(path).split('/').filter(Boolean);`,
  },
  {
    id: 'catch-all-needs-segment',
    models: 'catch-all does not match zero segments',
    file: ROUTER,
    from: `    if (segment.kind === 'catchAll') {
      params[segment.name]`,
    to: `    if (segment.kind === 'catchAll') {
      if (index >= pathSegs.length) return undefined;
      params[segment.name]`,
  },
  {
    id: 'implicit-head-from-stream',
    models: 'implicit HEAD served by a streaming GET',
    file: ROUTER,
    from: `routes.filter((route) => route.transport === 'buffer'),`,
    to: `routes,`,
  },
  {
    id: 'allow-one-pattern',
    models: 'Allow built from the first matching pattern only',
    file: ROUTER,
    from: `  for (const route of routes) {
    if (!matchCompiled(compilePattern(route.pattern), pathSegs)) continue;`,
    to: `  let onlyPattern: string | undefined;
  for (const route of routes) {
    if (!matchCompiled(compilePattern(route.pattern), pathSegs)) continue;
    onlyPattern ??= route.pattern;
    if (route.pattern !== onlyPattern) continue;`,
  },
  {
    id: 'allow-order',
    models: 'Allow in discovery order instead of canonical order',
    file: ROUTER,
    from: `  return [...methods].sort((a, b) => {`,
    // The original sort is left behind as unreachable code, which the transpiler accepts.
    to: `  return [...methods];
  [...methods].sort((a, b) => {`,
  },
  {
    id: 'trailing-slash-kept',
    models: 'trailing slash not normalized',
    file: ROUTER,
    from: `  const normalized = resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;`,
    to: `  const normalized = resolved;`,
  },
  {
    id: 'ws-ranked-like-http',
    models: 'WS upgrades ranked by specificity like HTTP instead of first registered',
    file: 'src/http/ws-core.ts',
    from: `    .find((entry) => entry.params);`,
    to: `    .filter((entry) => entry.params)
    .sort((a, b) => a.def.pattern.split(':').length - b.def.pattern.split(':').length)[0];`,
  },
  {
    id: 'case-insensitive-static',
    models: 'static segments compared case-insensitively',
    file: ROUTER,
    from: `      if (segment.value !== pathSegs[index]) return undefined;`,
    to: `      if (segment.value.toLowerCase() !== pathSegs[index].toLowerCase()) return undefined;`,
  },
];

function runSuite(dir: string): { passed: boolean; failed: number } {
  const out = join(dir, 'vitest.json');
  const res = spawnSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/vitest/vitest.mjs'),
      'run',
      'test/router-parity',
      '--reporter=json',
      `--outputFile=${out}`,
    ],
    { cwd: dir, env: { ...process.env, ROUTER_PARITY_CAPTURE: '' }, encoding: 'utf8', stdio: 'pipe' },
  );
  let failed = 0;
  try {
    failed = (JSON.parse(readFileSync(out, 'utf8')) as { numFailedTests: number }).numFailedTests;
  } catch {
    failed = -1; // the suite did not even report, which also kills the mutant
  }
  return { passed: res.status === 0, failed };
}

function copyTree(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'router-mutants-'));
  for (const entry of ['src', 'test']) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json', 'vitest.config.ts']) cpSync(join(ROOT, file), join(dir, file));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function main(): void {
  const only = process.env.MUTANTS_ONLY?.split(',');
  const mutants = only ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
  const dir = copyTree();
  const rows: Array<{ id: string; models: string; result: string; failedTests: number }> = [];

  try {
    const control = runSuite(dir);
    if (!control.passed)
      throw new Error('the unmutated copy fails the parity suite; no mutant result would mean anything');

    for (const mutant of mutants) {
      const path = join(dir, mutant.file);
      const original = readFileSync(path, 'utf8');
      const hits = original.split(mutant.from).length - 1;
      if (hits !== 1) throw new Error(`${mutant.id}: search text found ${hits} times in ${mutant.file}`);

      writeFileSync(path, original.replace(mutant.from, mutant.to));
      try {
        const { passed, failed } = runSuite(dir);
        rows.push({
          id: mutant.id,
          models: mutant.models,
          result: passed ? 'SURVIVED' : 'killed',
          failedTests: failed,
        });
        process.stderr.write(`[mutants] ${mutant.id}: ${passed ? 'SURVIVED' : `killed (${failed} failing)`}\n`);
      } finally {
        writeFileSync(path, original);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('| mutant | models | result | failing tests |');
  console.log('| --- | --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.id} | ${row.models} | ${row.result} | ${row.failedTests} |`);
  const killed = rows.filter((row) => row.result === 'killed').length;
  console.log(`\n${killed}/${rows.length} killed`);

  // The guarantee this script makes: the real src/ was never touched.
  execFileSync('git', ['diff', '--exit-code', '--', 'src'], { cwd: ROOT, stdio: 'inherit' });
  if (killed !== rows.length) process.exitCode = 1;
}

main();
