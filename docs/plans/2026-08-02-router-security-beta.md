# Router Security Beta Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `26.8.0-beta.0` with complete HEAD/OPTIONS behavior, safe constrained route parameters, strict path handling, accurate documentation, and clean dependency audits.

**Architecture:** Keep the linear route table, but compile and validate each pattern once. Centralize path syntax, matching, method fallback, and `Allow` calculation in the runtime-neutral HTTP layer so Node and Fetch adapters stay behaviorally identical. Remediate tooling dependencies without changing the package's Node 18 runtime contract or its one required runtime dependency.

**Tech Stack:** TypeScript, legacy decorators, Node HTTP, Fetch API, Vitest, OpenAPI 3.1, Astro/Starlight, npm lockfiles, GitHub/Gitea Actions.

---

### Task 1: Compile and validate route patterns

**Skills:** `@superpowers:test-driven-development`, `@security-review`

**Files:**
- Modify: `src/http/router.ts`
- Modify: `src/http/types.ts`
- Test: `test/router.test.ts`

**Step 1: Write failing compiler tests**

Add tests that establish the supported grammar and precedence:

```typescript
describe('compilePattern', () => {
  it('compiles constrained params and gives them precedence over plain params', () => {
    const routes = [route('GET', '/users/:value'), route('GET', '/users/:id(\\d+)')];
    expect(matchRoute(routes, 'GET', '/users/42')?.def.pattern).toBe('/users/:id(\\d+)');
    expect(matchRoute(routes, 'GET', '/users/diego')?.def.pattern).toBe('/users/:value');
  });

  it.each([
    '/files/:rest*/tail',
    '/users/:',
    '/users/:id/:id',
    '/users//:id',
    '/users/:id((a+)+)',
    '/users/:id((?=a)a)',
    '/users/:id(\\1)',
  ])('rejects invalid or unsafe pattern %s', (pattern) => {
    expect(() => compilePattern(pattern)).toThrow(/invalid route pattern|unsafe route constraint/);
  });
});
```

Also cover numeric, UUID-like, slug, and bounded-quantifier examples; a constraint must match the complete decoded segment.

**Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run test/router.test.ts
```

Expected: FAIL because `compilePattern` and constrained matching do not exist.

**Step 3: Implement the compiled representation**

In `src/http/router.ts`, add:

```typescript
type CompiledSegment =
  | { kind: 'static'; value: string }
  | { kind: 'param'; name: string; constraint?: RegExp }
  | { kind: 'catchAll'; name: string };

export interface CompiledPattern {
  source: string;
  normalized: string;
  shape: string;
  segments: CompiledSegment[];
  kinds: number[]; // static=3, constrained=2, param=1; catch-all stored separately
  catchAll: boolean;
}
```

Implement `compilePattern(pattern)`, `matchCompiled(compiled, pathSegments)`, and a string-keyed cache used by `matchPattern`. Parse `:name(expr)` only when the closing `)` ends the segment. Anchor accepted constraints as `^(?:${expr})$`.

Implement `assertSafeConstraint` as a small whitelist parser. Permit literals, character classes, `\\d`/`\\w`/`\\s` classes, escaped literals, and simple quantifiers. Reject expression length above 128, groups, alternation, anchors, lookarounds, backreferences, nested quantifiers, and adjacent unbounded quantified atoms without a separating literal. Do not add a runtime dependency.

Build `shape` from segment kinds and constraint source so `:id` and `:name` have the same effective shape.

**Step 4: Run tests and confirm GREEN**

Run:

```bash
npx vitest run test/router.test.ts
npm run typecheck
```

Expected: all router tests pass and TypeScript reports no errors.

**Step 5: Commit**

```bash
git add src/http/router.ts src/http/types.ts test/router.test.ts
git commit -s -m "feat(router): compile safe constrained patterns"
```

### Task 2: Validate request paths and route-table ambiguity

**Skills:** `@superpowers:test-driven-development`, `@security-review`

**Files:**
- Modify: `src/http/router.ts`
- Modify: `src/app/index.ts`
- Modify: `src/app/types.ts`
- Test: `test/router.test.ts`
- Test: `test/app.test.ts`

**Step 1: Write failing path-policy tests**

Add router tests for the approved normalization:

```typescript
expect(normalizeRequestPath('/users')).toBe('/users');
expect(normalizeRequestPath('/users/')).toBe('/users');
expect(normalizeRequestPath('/')).toBe('/');
expect(() => normalizeRequestPath('/users//42')).toThrow(/repeated slash/);
expect(() => normalizeRequestPath('/users/%E0%A4%A')).toThrow(/malformed path encoding/);
```

Add app-construction tests proving that identical routes and routes that differ only by parameter names fail before serving:

```typescript
expect(() => createApp({ modules: [DuplicateRouteModule] })).toThrow(/ambiguous route.*GET/);
```

Cover the same path under different methods as valid.

**Step 2: Run focused tests and confirm RED**

```bash
npx vitest run test/router.test.ts test/app.test.ts
```

Expected: FAIL because normalization and ambiguity checks are absent.

**Step 3: Implement request normalization**

Add `InvalidRequestPathError` and `normalizeRequestPath(path)` to `src/http/router.ts`. Strip exactly one trailing slash except at root, reject `//`, and call `decodeURIComponent` on every raw segment only to validate encoding. Matching still compares static segments according to the existing encoded-path contract and decodes captured values once.

**Step 4: Implement route-table validation**

Store a `compiled` pattern on each internal `RoutePlan`/`RouteDef`, or expose a shared cache accessor if that avoids duplicating state. During `collectControllers`, compile each joined pattern and compare the candidate's method plus `shape` with existing route plans. Throw an error that includes method, pattern, controller/handler, and conflicting declaration.

Apply the same validation after remote mesh routes join. A remote conflict must name both mesh owner URLs rather than silently selecting registration order.

**Step 5: Run focused and mesh tests**

```bash
npx vitest run test/router.test.ts test/app.test.ts test/mesh/fetch-boot.test.ts test/mesh/integration.test.ts
npm run typecheck
```

Expected: all selected tests pass.

**Step 6: Commit**

```bash
git add src/http/router.ts src/app/index.ts src/app/types.ts test/router.test.ts test/app.test.ts
git commit -s -m "fix(router): reject invalid and ambiguous paths"
```

### Task 3: Add HEAD and OPTIONS to the public decorator API

**Skills:** `@superpowers:test-driven-development`

**Files:**
- Modify: `src/metadata.ts`
- Modify: `src/index.ts`
- Modify: `src/signals.ts`
- Test: `test/metadata.test.ts`
- Test: `test/smoke.test.ts`

**Step 1: Write failing decorator tests**

```typescript
class Methods {
  @Head('/resource') head() {}
  @Options('/resource') options() {}
}

expect(getRoutes(Methods).map(({ method }) => method)).toEqual(['HEAD', 'OPTIONS']);
```

Add a public-barrel smoke test that imports `Head`, `Options`, and `HttpMethod` from `src/index.ts`.

**Step 2: Run tests and confirm RED**

```bash
npx vitest run test/metadata.test.ts test/smoke.test.ts
```

Expected: FAIL because the exports do not exist.

**Step 3: Implement decorators and messages**

Extend `HttpMethod`:

```typescript
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
```

Create buffered `Head` and `Options` decorators through `routeDecorator`, export them from `src/index.ts`, and update `TransportMismatchError`'s buffered-method message. Keep `@Html` restricted to GET/POST and update its rejection text to include HEAD/OPTIONS.

**Step 4: Run tests and typecheck**

```bash
npx vitest run test/metadata.test.ts test/smoke.test.ts test/transport-enforcement.test.ts test/views-html.test.ts
npm run typecheck
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/metadata.ts src/index.ts src/signals.ts test/metadata.test.ts test/smoke.test.ts
git commit -s -m "feat(router): expose HEAD and OPTIONS decorators"
```

### Task 4: Implement runtime-neutral HEAD, OPTIONS, and path errors

**Skills:** `@superpowers:test-driven-development`, `@security-review`

**Files:**
- Modify: `src/http/router.ts`
- Modify: `src/http/core.ts`
- Modify: `src/http/web.ts`
- Modify: `src/http/server.ts`
- Test: `test/router.test.ts`
- Test: `test/http.test.ts`
- Test: `test/fetch.test.ts`
- Test: `test/parity.test.ts`
- Test: `test/transport-security.test.ts`

**Step 1: Write failing method-semantics tests**

Cover these cases in both Node and `app.fetch`:

```typescript
// Explicit HEAD wins.
// Otherwise buffered GET runs once, retains status/headers, and emits an empty body.
// Streaming GET does not become implicit HEAD.
// Explicit OPTIONS wins.
// Automatic OPTIONS returns 204 and deterministic Allow.
// GET implies HEAD; every existing path implies OPTIONS.
// CORS preflight still runs before explicit/automatic OPTIONS.
// Double slash and malformed encoding return 400 with security headers.
```

Use a canonical expected header such as `GET, HEAD, POST, OPTIONS`.

**Step 2: Run focused tests and confirm RED**

```bash
npx vitest run test/router.test.ts test/http.test.ts test/fetch.test.ts test/parity.test.ts test/transport-security.test.ts
```

Expected: new assertions fail under the current 405 behavior.

**Step 3: Implement method resolution**

In `src/http/router.ts`, add a stable method order and helpers:

```typescript
export interface ResolvedRoute extends MatchedRoute {
  implicitHead: boolean;
}

export function resolveRoute(routes: RouteDef[], method: string, path: string): ResolvedRoute | undefined;
export function allowedMethods(routes: RouteDef[], path: string): HttpMethod[];
```

`resolveRoute` tries explicit method first. For HEAD only, it falls back to a matching buffered GET. `allowedMethods` deduplicates explicit methods, adds HEAD for buffered GET, adds OPTIONS for every existing path, and sorts canonically.

**Step 4: Implement core outcomes**

At the start of `handle`, normalize the path and render `InvalidRequestPathError` as `400`. Preserve the existing CORS-preflight branch. Resolve explicit OPTIONS normally; otherwise return buffered `204` with `allow` and empty body. For an implicit or explicit HEAD route, run the normal pipeline but replace a buffered result body with `''`. Reject a stream outcome for HEAD as a transport mismatch rather than opening a stream.

**Step 5: Align body acquisition in both adapters**

Replace early `matchRoute` calls in `src/http/web.ts` and `src/http/server.ts` with the same normalization and resolution helper used by `handle`. If path validation fails before body acquisition, render `400` through `onError` with injected security/CORS headers. Never read a request body for automatic OPTIONS or an invalid path.

**Step 6: Run focused tests and confirm GREEN**

```bash
npx vitest run test/router.test.ts test/http.test.ts test/fetch.test.ts test/parity.test.ts test/transport-security.test.ts
npm run typecheck
```

Expected: all selected tests pass with Node/Fetch parity.

**Step 7: Commit**

```bash
git add src/http/router.ts src/http/core.ts src/http/web.ts src/http/server.ts test/router.test.ts test/http.test.ts test/fetch.test.ts test/parity.test.ts test/transport-security.test.ts
git commit -s -m "feat(http): complete HEAD and OPTIONS semantics"
```

### Task 5: Project constraints into OpenAPI and introspection

**Skills:** `@superpowers:test-driven-development`

**Files:**
- Modify: `src/openapi.ts`
- Modify: `src/app/introspect.ts`
- Test: `test/openapi.test.ts`
- Test: `test/graph-viz.test.ts`

**Step 1: Write failing OpenAPI tests**

Add `@Get('/:id(\\d+)')`, explicit `@Head`, and explicit `@Options` routes to the fixture. Assert:

```typescript
expect(doc.paths['/api/users/{id}']).toBeDefined();
expect((doc.paths['/api/users/{id}'].get as any).parameters).toContainEqual(
  expect.objectContaining({ name: 'id', schema: { type: 'string', pattern: '\\d+' } }),
);
expect(doc.paths['/api/users/{id}'].head).toBeDefined();
expect(doc.paths['/api/users/{id}'].options).toBeDefined();
```

Assert that automatic HEAD/OPTIONS operations are not invented.

**Step 2: Run tests and confirm RED**

```bash
npx vitest run test/openapi.test.ts test/graph-viz.test.ts
```

Expected: constrained template parsing or schema assertions fail.

**Step 3: Implement projection**

Reuse the route compiler's parsed segment data instead of parsing the syntax a second way. Convert params and catch-alls to `{name}`. Add `schema.pattern` only for constrained params. Ensure `inspect`, `explain`, Mermaid, and DOT retain the human-readable original pattern.

**Step 4: Run tests and typecheck**

```bash
npx vitest run test/openapi.test.ts test/graph-viz.test.ts test/app.test.ts
npm run typecheck
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/openapi.ts src/app/introspect.ts test/openapi.test.ts test/graph-viz.test.ts
git commit -s -m "feat(openapi): document constrained route params"
```

### Task 6: Remove root and website dependency advisories

**Skills:** `@security-review`

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `website/package.json`
- Modify: `website/package-lock.json`
- Test: `bench/servers/nestjs-express.ts`
- Test: `bench/servers/nestjs-fastify.ts`

**Step 1: Record the failing audit baseline**

```bash
npm audit
npm --prefix website audit
npm audit --omit=dev
```

Expected: root full audit reports 17 advisories, website reports 3, runtime-only root reports 0.

**Step 2: Apply supported direct updates**

Update root dependencies with explicit commands so the manifests and lockfile agree:

```bash
npm install --save-dev vitest@^3.2.6 \
  @nestjs/common@^11.1.28 @nestjs/core@^11.1.28 \
  @nestjs/platform-express@^11.1.28 @nestjs/platform-fastify@^11.1.28 \
  fastify@^5.11.0 miniflare@^4.20260730.0 \
  @eslint/js@^9.39.5 eslint@^9.39.5 prettier@^3.9.6 \
  tsx@^4.23.5 typescript-eslint@^8.65.0 ws@^8.21.1
npm --prefix website install astro@^7.1.6 @astrojs/starlight@^0.41.6
```

Do not bump TypeScript, ESLint, or GraphQL across their next major versions.

**Step 3: Add narrow overrides only for unresolved vulnerable transitives**

Run `npm audit --json` and inspect the exact remaining paths. Add the smallest overrides justified by that output, initially:

```json
{
  "overrides": {
    "@nestjs/platform-fastify": {
      "find-my-way": "9.7.0"
    },
    "autocannon": {
      "hyperid": {
        "uuid": "11.1.1"
      }
    }
  }
}
```

If npm rejects nested override syntax, express the same ownership with `$` references or the supported nested-object form for the installed npm version. Never add a global override when a package-scoped one works.

**Step 4: Prove compatibility before accepting overrides**

```bash
npm run typecheck
npm test
npm run bench
```

Expected: tests pass; Express, Fastify, Nest Express, and Nest Fastify scenarios start and complete; Autocannon produces all scenario rows. If the UUID override breaks Autocannon, revert only that override and replace/isolate Autocannon in a follow-up commit within this task until the full audit is clean.

**Step 5: Verify clean audits**

```bash
npm audit
npm audit --omit=dev
npm --prefix website audit
```

Expected: all three commands exit 0 with zero vulnerabilities.

**Step 6: Commit**

```bash
git add package.json package-lock.json website/package.json website/package-lock.json
git commit -s -m "chore(deps): remediate security advisories"
```

### Task 7: Add security and documentation gates to CI

**Skills:** `@security-review`

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Step 1: Define the expected gates**

The CI job must install root and website lockfiles, audit both, build docs, and preserve the existing Node 18 package gate. The GitHub-only release job must audit the root tree immediately after `npm ci` and before `npm publish`.

**Step 2: Update CI**

Add these steps after the root `npm ci`:

```yaml
      - run: npm audit
      - run: npm ci --prefix website
      - run: npm audit --prefix website
      - run: npm run docs:build
```

Keep lint, format, complexity, typecheck, test, and build unchanged.

**Step 3: Update the GitHub release gate**

Add `npm audit` after `npm ci` in `.github/workflows/release.yml`. Do not change the tag trigger, Gitea server guard, Node 22 OIDC setup, dist-tag derivation, or `npm publish` command.

Do not modify `stage.yml` or `promote.yml`; their verified GitFlow responsibilities remain:

- Gitea `main` → Verdaccio `stg`;
- Gitea `main` and `v*` tags → GitHub;
- GitHub `v*` → npm OIDC release.

**Step 4: Validate workflow syntax and diff**

```bash
npx prettier --check .github/workflows/ci.yml .github/workflows/release.yml
git diff --check
```

If Prettier does not parse the workflow format in this repo, inspect with `ruby -e "require 'yaml'; YAML.load_file(ARGV[0])" <file>` and record that command instead.

**Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -s -m "ci: gate releases on clean dependency audits"
```

### Task 8: Align public documentation and prepare the August beta

**Skills:** `@writing-clearly-and-concisely`

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `src/index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `website/src/content/docs/guides/routing.md`
- Modify: `website/src/content/docs/reference/decorators.md`
- Modify: `website/src/content/docs/guides/openapi.md`
- Create: `website/src/content/docs/404.md`

**Step 1: Update routing documentation from the verified behavior**

Document:

- `@Head` and `@Options`;
- explicit-route priority and automatic fallbacks;
- canonical `Allow` behavior;
- `/path` equals `/path/`;
- `//` and malformed encoding return `400`;
- catch-all must be final;
- `:id(\\d+)`, whole-segment matching, precedence, and the safe-subset restriction;
- the matcher remains linear and a radix tree remains deferred.

Remove the current statement that bare OPTIONS returns 405.

**Step 2: Update OpenAPI and decorator references**

Show that explicit HEAD/OPTIONS appear as operations and constrained params produce `schema.pattern`. Keep automatic fallback operations out of generated documents.

**Step 3: Fix the Starlight 404 warning**

Create the missing `404.md` entry with valid Starlight frontmatter and concise navigation back to the docs index. Run `npm run docs:build` and confirm the line `Entry docs → 404 was not found` disappears.

**Step 4: Bump the beta version consistently**

Run:

```bash
npm version 26.8.0-beta.0 --no-git-tag-version
```

Update `src/index.ts`'s `VERSION` constant and add a `26.8.0-beta.0` CHANGELOG entry covering routes, security remediation, docs, and compatibility. Confirm README's CalVer examples remain accurate.

**Step 5: Verify docs and version consistency**

```bash
npm run docs:build
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if (p.version !== l.version || p.version !== l.packages[''].version) process.exit(1)"
rg -n "26\.7\.0-beta\.0|Not built|bare `OPTIONS`" README.md CHANGELOG.md src website/src/content/docs
git diff --check
```

Expected: docs build without the 404 warning; package versions agree; any old beta string is retained only in historical release examples.

**Step 6: Commit**

```bash
git add README.md CHANGELOG.md src/index.ts package.json package-lock.json website/src/content/docs
git commit -s -m "docs: document router completeness for beta"
```

### Task 9: Run the complete release-candidate verification

**Skills:** `@superpowers:verification-before-completion`, `@security-review`

**Files:**
- Modify only if a verification failure reveals an in-scope defect.

**Step 1: Run static and Node gates**

```bash
npm run lint
npm run format:check
npm run complexity:check
npm run typecheck
npm run typecheck:bench
npm test
npm run build
```

Expected: every command exits 0. Record the existing lint-warning count separately; introduce no new warnings.

**Step 2: Run multi-runtime gates**

```bash
npm run test:deno
npm run test:bun
npm run test:edge
```

Expected: every installed runtime suite exits 0. If a runtime is unavailable, report the exact missing command; do not claim that suite passed.

**Step 3: Run security, docs, and benchmark gates**

```bash
npm audit
npm audit --omit=dev
npm --prefix website audit
npm run docs:build
npm run bench
```

Expected: zero advisories; docs build without warning; all benchmark scenarios complete.

**Step 4: Inspect the publish artifact without publishing**

```bash
npm pack --dry-run
```

Expected: package contains `dist`, assets, README, CHANGELOG, and LICENSE; version is `26.8.0-beta.0`; no docs worktree, tests, secrets, or local environment files appear.

**Step 5: Review branch and workflow boundaries**

```bash
git status --short --branch
git log --oneline --decorate develop..HEAD
git diff --check develop...HEAD
git diff --stat develop...HEAD
```

Expected: clean `feat/router-security-beta`; all commits carry `Signed-off-by`; no tag, registry publication, `main` merge, or workflow secret change occurred.

**Step 6: Commit any verification-only repair**

Only if Step 1–5 exposed an in-scope defect:

```bash
git add <exact repaired files>
git commit -s -m "fix: address beta verification findings"
```

Re-run the failed gate and the complete related suite after any repair.
