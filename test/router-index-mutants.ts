/**
 * Mutation check for the radix index (CARD-07, #109): the twelve bug classes of the frozen
 * `test/router-parity/mutants.ts`, re-targeted at the code that replaced the linear matcher.
 *
 *   npm run parity:mutants:index
 *
 * The frozen script cannot run against this router: its search texts are lines of the old linear
 * scan, and it refuses to start when one is missing — which is what it was written to do ("mutants
 * against the new code belong to CARD-07"). This one keeps everything else identical: the same
 * suite (`vitest run test/router-parity`, untouched), the same temporary copy of `src/`, the same
 * exactly-once rule for every search text, the same unmutated control run, and the same final
 * `git diff --exit-code src`. Ids and the bug each one models are unchanged; six mutants apply
 * verbatim, six are re-targeted. A mutant may need more than one edit when the new code holds the
 * same rule in two places (the walk filters, then `matchCompiled` collects params); every edit
 * models the same bug.
 *
 * Not part of `npm test`: it runs the suite once per mutant.
 */
import { spawnSync, execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import { join, resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const ROUTER = 'src/http/router.ts';

interface Edit {
  file: string;
  from: string;
  to: string;
}

interface Mutant {
  id: string;
  models: string;
  /** `verbatim`: the frozen mutant's own edit. `retargeted`: the same bug, written against the index. */
  origin: 'verbatim' | 'retargeted';
  edits: Edit[];
}

export const MUTANTS: Mutant[] = [
  {
    id: 'no-backtrack',
    models: 'no backtracking to a param branch once a static first segment was entered',
    origin: 'retargeted',
    edits: [
      {
        file: ROUTER,
        from: `    if (next) walk(next, search, segs, depth + 1);`,
        to: `    if (next && depth === 0) return walk(next, search, segs, depth + 1);
    if (next) walk(next, search, segs, depth + 1);`,
      },
    ],
  },
  {
    id: 'precedence-swapped',
    models: 'static and plain-param precedence swapped',
    origin: 'verbatim',
    edits: [
      {
        file: ROUTER,
        from: `.map((segment) => (segment.kind === 'static' ? 3 : segment.constraint ? 2 : 1)),`,
        to: `.map((segment) => (segment.kind === 'static' ? 1 : segment.constraint ? 2 : 3)),`,
      },
    ],
  },
  {
    id: 'tie-last-registered',
    models: 'equal-rank tie broken by the last-registered declaration',
    origin: 'retargeted',
    edits: [
      {
        file: ROUTER,
        from: `    bucket.sort((a, b) => moreSpecific(b.compiled, a.compiled));`,
        to: `    bucket.reverse().sort((a, b) => moreSpecific(b.compiled, a.compiled));`,
      },
    ],
  },
  {
    id: 'constraint-ignored',
    models: 'param constraint not tested during lookup',
    origin: 'retargeted',
    edits: [
      { file: ROUTER, from: `      if (edge.constraint && !edge.constraint.test(value)) continue;\n`, to: `` },
      // the frozen mutant's own edit: without it the walk would pick a route whose params then fail to collect
      {
        file: ROUTER,
        from: `    if (segment.constraint && !segment.constraint.test(value)) return undefined;\n`,
        to: ``,
      },
    ],
  },
  {
    id: 'decode-before-split',
    models: 'path decoded before splitting, so %2F becomes a separator',
    origin: 'verbatim',
    edits: [
      {
        file: ROUTER,
        from: `  return path.split('/').filter(Boolean);`,
        to: `  return decodeURIComponent(path).split('/').filter(Boolean);`,
      },
    ],
  },
  {
    id: 'catch-all-needs-segment',
    models: 'catch-all does not match zero segments',
    origin: 'retargeted',
    edits: [
      {
        file: ROUTER,
        from: `  if (node.catchAll.length) offer(search, node.catchAll);`,
        to: `  if (node.catchAll.length && depth < segs.length) offer(search, node.catchAll);`,
      },
    ],
  },
  {
    id: 'implicit-head-from-stream',
    models: 'implicit HEAD served by a streaming GET',
    origin: 'retargeted',
    edits: [
      {
        file: ROUTER,
        from: `  const fallback = findRoute(index, 'GET', search, isBuffered);`,
        to: `  const fallback = findRoute(index, 'GET', search);`,
      },
    ],
  },
  {
    id: 'allow-one-pattern',
    models: 'Allow built from the first matching pattern only',
    origin: 'retargeted',
    edits: [
      {
        file: ROUTER,
        from: `    if (method === 'GET' && findRoute(index, method, search, isBuffered)) methods.add('GET').add('HEAD');
    else if (findRoute(index, method, search)) methods.add(method);`,
        to: `    const hit = findRoute(index, method, search);
    if (!hit) continue;
    onlyPattern ??= hit.def.pattern;
    if (hit.def.pattern !== onlyPattern) continue;
    methods.add(method);
    if (method === 'GET' && findRoute(index, method, search, isBuffered)) methods.add('HEAD');`,
      },
      {
        file: ROUTER,
        from: `  const methods = new Set<string>();\n\n  for (const method of index.methods) {`,
        to: `  const methods = new Set<string>();\n  let onlyPattern: string | undefined;\n\n  for (const method of index.methods) {`,
      },
    ],
  },
  {
    id: 'allow-order',
    models: 'Allow in discovery order instead of canonical order',
    origin: 'verbatim',
    edits: [
      {
        file: ROUTER,
        from: `  return [...methods].sort((a, b) => {`,
        to: `  return [...methods];
  [...methods].sort((a, b) => {`,
      },
    ],
  },
  {
    id: 'trailing-slash-kept',
    models: 'trailing slash not normalized',
    origin: 'verbatim',
    edits: [
      {
        file: ROUTER,
        from: `  const normalized = resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved;`,
        to: `  const normalized = resolved;`,
      },
    ],
  },
  {
    id: 'ws-ranked-like-http',
    models: 'WS upgrades ranked by specificity like HTTP instead of first registered',
    origin: 'verbatim',
    edits: [
      {
        file: 'src/http/ws-core.ts',
        from: `    .find((entry) => entry.params);`,
        to: `    .filter((entry) => entry.params)
    .sort((a, b) => a.def.pattern.split(':').length - b.def.pattern.split(':').length)[0];`,
      },
    ],
  },
  {
    id: 'case-insensitive-static',
    models: 'static segments compared case-insensitively',
    origin: 'retargeted',
    edits: [
      {
        file: ROUTER,
        from: `    const next = node.statics.size ? node.statics.get(segment) : undefined;`,
        to: `    const next = [...node.statics].find(([key]) => key.toLowerCase() === segment.toLowerCase())?.[1];`,
      },
      // the frozen mutant's own edit, so the chosen route also collects its params
      {
        file: ROUTER,
        from: `      if (segment.value !== pathSegs[index]) return undefined;`,
        to: `      if (segment.value.toLowerCase() !== pathSegs[index].toLowerCase()) return undefined;`,
      },
    ],
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
  const dir = mkdtempSync(join(os.tmpdir(), 'router-index-mutants-'));
  for (const entry of ['src', 'test']) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json', 'vitest.config.ts']) cpSync(join(ROOT, file), join(dir, file));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Applies every edit of one mutant, each of which must find its search text exactly once. */
function applyMutant(dir: string, mutant: Mutant): Map<string, string> {
  const originals = new Map<string, string>();

  for (const edit of mutant.edits) {
    const path = join(dir, edit.file);
    if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'));
    const current = readFileSync(path, 'utf8');
    const hits = current.split(edit.from).length - 1;
    if (hits !== 1) throw new Error(`${mutant.id}: search text found ${hits} times in ${edit.file}`);
    writeFileSync(path, current.replace(edit.from, edit.to));
  }

  return originals;
}

function main(): void {
  const only = process.env.MUTANTS_ONLY?.split(',');
  const mutants = only ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
  const dir = copyTree();
  const rows: Array<{ id: string; origin: string; models: string; result: string; failedTests: number }> = [];

  try {
    const control = runSuite(dir);
    if (!control.passed)
      throw new Error('the unmutated copy fails the parity suite; no mutant result would mean anything');

    for (const mutant of mutants) {
      const originals = applyMutant(dir, mutant);
      try {
        const { passed, failed } = runSuite(dir);
        rows.push({
          id: mutant.id,
          origin: mutant.origin,
          models: mutant.models,
          result: passed ? 'SURVIVED' : 'killed',
          failedTests: failed,
        });
        process.stderr.write(`[mutants] ${mutant.id}: ${passed ? 'SURVIVED' : `killed (${failed} failing)`}\n`);
      } finally {
        for (const [path, original] of originals) writeFileSync(path, original);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('| mutant | edit | models | result | failing tests |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const row of rows)
    console.log(`| ${row.id} | ${row.origin} | ${row.models} | ${row.result} | ${row.failedTests} |`);
  const killed = rows.filter((row) => row.result === 'killed').length;
  console.log(`\n${killed}/${rows.length} killed`);

  // The guarantee this script makes: the real src/ was never touched.
  execFileSync('git', ['diff', '--exit-code', '--', 'src'], { cwd: ROOT, stdio: 'inherit' });
  if (killed !== rows.length) process.exitCode = 1;
}

main();
