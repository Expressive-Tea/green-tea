/**
 * Mutation check for the router-parity corpus: does it catch the bugs a radix router is likely to
 * have? Each mutant is one targeted bug, applied as one or more edits to a *temporary copy* of
 * `src/`. The suite runs against that copy, and the mutant is killed if any test fails.
 *
 *   npm run parity:mutants
 *
 * Not part of `npm test`: it runs the suite once per mutant. `src/` in this checkout is never
 * written; the run ends by checking `git diff --exit-code src` to prove it.
 *
 * The suite is the frozen corpus (`test/router-parity`, untouched) plus `test/router-index.test.ts`,
 * which covers the radix index's own seams (local/remote trees, index lifetime) that the corpus's
 * flat-array matcher cases cannot reach.
 *
 * Retargeted at the radix index in CARD-07 with the owner's approval: the original search texts
 * were lines of the linear scan that CARD-07 removed. The first twelve mutants keep their names and
 * the bug each one models; `origin` says whether the edit is the original one (`verbatim`) or the
 * same bug written against the index (`retargeted`). The rest (`radix`) model risks the index
 * itself introduced.
 *
 * Every edit's search text must be found exactly once and must change the file, so a refactor that
 * moves the code fails the run loudly instead of silently testing an unmutated copy. A mutant may
 * need more than one edit when the index holds the same rule in two places (the walk filters, then
 * `matchCompiled` collects params); every edit models the same bug.
 */
import { spawnSync, execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import { join, resolve } from 'path';

const ROOT = resolve(__dirname, '..', '..');
const ROUTER = 'src/http/router.ts';

interface Edit {
  file: string;
  from: string;
  to: string;
}

interface Mutant {
  id: string;
  models: string;
  /** `verbatim`: the original edit. `retargeted`: the same bug, written against the index. `radix`: a risk of the index itself. */
  origin: 'verbatim' | 'retargeted' | 'radix';
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
        from: `    const segment = segs[depth];\n`,
        to: `    const segment = segs[depth];
    const first = depth === 0 ? node.statics.get(segment) : undefined;
    if (first) {
      stackNodes.push(first);
      stackDepths.push(1);
      continue;
    }\n`,
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
        from: `    if (node.catchAll.length) {`,
        to: `    if (node.catchAll.length && depth < segs.length) {`,
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
  {
    id: 'static-map-ignores-method',
    models: 'the exact-path map for static routes is shared across methods, so a hit ignores the method',
    origin: 'radix',
    edits: [
      {
        file: ROUTER,
        from: `  const trees = new Map<string, MethodTree>();`,
        to: `  const trees = new Map<string, MethodTree>();\n  const anyMethod = new Map<string, Terminal[]>();`,
      },
      {
        file: ROUTER,
        from: `    const tree: MethodTree = { root: newNode(), exactPaths: new Map() };`,
        to: `    const tree: MethodTree = { root: newNode(), exactPaths: anyMethod };`,
      },
    ],
  },
  {
    id: 'static-map-shadows-earlier',
    models: 'the exact-path map lists identical static routes newest first, shadowing the earlier, higher-ranked one',
    origin: 'radix',
    edits: [{ file: ROUTER, from: `    if (same) same.push(terminal);`, to: `    if (same) same.unshift(terminal);` }],
  },
  {
    id: 'prune-bound-off-by-one',
    models: 'branch pruning off by one, so the next-ranked route wins over the better one it pruned',
    origin: 'radix',
    edits: [
      {
        file: ROUTER,
        from: `    if (search.best && node.min >= search.best.rank) continue;`,
        to: `    if (search.best && node.min + 1 >= search.best.rank) continue;`,
      },
    ],
  },
  {
    id: 'empty-skip-prunes-match',
    models: 'the empty-collection skip also skips a node with exactly one static child',
    origin: 'radix',
    edits: [
      {
        file: ROUTER,
        from: `    const next = node.statics.size ? node.statics.get(segment) : undefined;`,
        to: `    const next = node.statics.size > 1 ? node.statics.get(segment) : undefined;`,
      },
    ],
  },
  {
    id: 'tie-goes-remote',
    models: 'an equal-specificity tie between the local and remote trees goes to the remote route',
    origin: 'radix',
    edits: [{ file: ROUTER, from: `  return local.order < remote.order ? local : remote;`, to: `  return remote;` }],
  },
  {
    id: 'allow-local-only',
    models: 'Allow, 405 and OPTIONS computed from the local tree only',
    origin: 'radix',
    edits: [
      {
        file: ROUTER,
        from: `    if (method === 'GET' && findRoute(index, method, search, isBuffered)) methods.add('GET').add('HEAD');
    else if (findRoute(index, method, search)) methods.add(method);`,
        to: `    const localOnly = { ...index, remote: undefined };
    if (method === 'GET' && findRoute(localOnly, method, search, isBuffered)) methods.add('GET').add('HEAD');
    else if (findRoute(localOnly, method, search)) methods.add(method);`,
      },
    ],
  },
  {
    id: 'implicit-head-local-only',
    models: 'implicit HEAD ignores buffered GETs in the remote tree',
    origin: 'radix',
    edits: [
      {
        file: ROUTER,
        from: `  const fallback = findRoute(index, 'GET', search, isBuffered);`,
        to: `  const fallback = findRoute({ ...index, remote: undefined }, 'GET', search, isBuffered);`,
      },
    ],
  },
  {
    id: 'stale-index-served',
    models: 'stale-index guard removed: the cache is keyed by array identity only',
    origin: 'radix',
    edits: [
      {
        file: ROUTER,
        from: `  if (cached?.size === routes.length) return cached;`,
        to: `  if (cached) return cached;`,
      },
    ],
  },
  {
    id: 'zero-catch-all-after-static-dead-end',
    models: 'a zero-segment catch-all is not tried where the path ends on a node that only continues statically',
    origin: 'radix',
    edits: [
      {
        file: ROUTER,
        from: `    if (node.catchAll.length) {`,
        to: `    if (node.catchAll.length && !(depth === segs.length && node.statics.size)) {`,
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
      'test/router-index.test.ts',
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

/** Applies every edit of one mutant. Each search text must be found exactly once and must change the file. */
function applyMutant(dir: string, mutant: Mutant): Map<string, string> {
  const originals = new Map<string, string>();

  try {
    for (const edit of mutant.edits) {
      const path = join(dir, edit.file);
      if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'));
      const current = readFileSync(path, 'utf8');
      const hits = current.split(edit.from).length - 1;
      if (hits !== 1) throw new Error(`${mutant.id}: search text found ${hits} times in ${edit.file}`);
      const mutated = current.replace(edit.from, edit.to);
      if (mutated === current) throw new Error(`${mutant.id}: edit left ${edit.file} unchanged`);
      writeFileSync(path, mutated);
    }

    for (const [path, original] of originals)
      if (readFileSync(path, 'utf8') === original) throw new Error(`${mutant.id}: ${path} is identical after mutation`);
  } catch (err) {
    restore(originals);
    throw err;
  }

  return originals;
}

function restore(originals: Map<string, string>): void {
  for (const [path, original] of originals) writeFileSync(path, original);
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
        restore(originals);
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
