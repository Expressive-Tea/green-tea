# Trust Release Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the gaps that four independent evaluations agree on, in the order that makes each one cheap. Prove portability in CI, make derived execution explainable, ship an observability contract, and move the documentation site out of the core repository so it gets its own lifecycle.

**Architecture:** Nothing here adds a runtime dependency. The observability work is a contract plus emission points, with exporters living outside core. The explain work is a resolver over data `explainRoute` already returns. The runtime matrix runs suites that already exist. The docs split moves a directory that is already self-contained.

**Tech Stack:** TypeScript, legacy decorators, Vitest, Deno/Bun/Workers runtimes, JSR, Astro/Starlight, GitHub/Gitea Actions.

---

## Why this order

The four reports in `.specs/reports/` were written independently and converge on one gap. Observability is the only dimension the CTO due diligence marks as risk **Alto** on its own (§5.3, risk register), it is P0 twice in the Trust Release report (§4, §5), and it is a listed con in the lead-dev report (§4). That is GH #10, and it is the largest item here — which is exactly why it is not first. The three phases before it are cheap, unblock evidence, and produce the material that #10's design needs.

Two things the reports demand that had **no issue filed**, both verified against the code rather than taken on the report's word:

- **Runtime matrix in CI.** `package.json:91-93` defines `test:deno`, `test:bun` and `test:edge`. `.github/workflows/ci.yml` runs none of them. `AGENTS.md:23` already warns that `npm test` does not cover the other runtimes — and CI does not close that. The framework's headline claim has no CI evidence. Trust Release §7 (P0), CTO §8.2 and P0-6.
- **`explain()` does not explain causality.** `src/app/introspect.ts:62` returns a flat `chain` with `needs`/`provides` per node, but never the edge from a need to the node that produced it. Trust Release §2 (P0).

One thing that **has** an issue but appears in no report: **#13 circuit breaker**. Neither the CTO report nor the Trust Release report raises it; the nearest item is "rate limiter" under the CTO's security pack (P0-3), which is a different mechanism. The issue itself already says a worked example in the docs might close it outright. It is scheduled last, as documentation.

**API freeze is deliberately not a phase.** `README.md:276` already declares it under `**next**`. It needs the RC boundary, and freezing a public surface before #10 lands would freeze an API that is still missing its observability contract. What this plan adds instead is a stability *contract* — a statement of which areas are volatile today, which promises nothing and commits to no date (Task 6.1).

**Out of scope: #21 and #17.** Both are claimed by `hgshreyas` with the design already settled in the issue threads. Do not touch them.

---

## Phase 0: Unblock releases

### Task 0.1: Scope the audit gate in stage and release

**Files:**
- Modify: `.github/workflows/stage.yml`
- Modify: `.github/workflows/release.yml`

`AGENTS.md:71` states the policy: `npm audit --omit=dev` blocks, everything else is `continue-on-error`. `ci.yml:56-59` implements it. `stage.yml:21` and `release.yml:26` run bare `npm audit`, so a dev-only advisory blocks a publish. This is drift, not a second policy.

That drift is what stopped work twice. The `nanoid` advisory reached the tree through `tsup → postcss → nanoid` — a build-tooling path that ships to nobody.

**Step 1:** In both files, change `npm audit` to `npm audit --omit=dev`, and add a non-blocking full `npm audit` with `continue-on-error: true` after it so the advisory is still visible in the log.

**Step 2:** Carry a comment on the blocking step pointing at the rule, in the voice `ci.yml` already uses — the next person to read it should see a decision, not an omission.

**Verify:** `grep -n "npm audit" .github/workflows/*.yml` — every blocking occurrence carries `--omit=dev`.

---

## Phase 1: Prove portability, and publish to JSR

These are one phase because they are one subject. The type error JSR found is on the `app.fetch` path, which is the path Deno, Bun and edge all use; a runtime matrix would have caught it first. Fixing them together means the matrix has a green baseline to protect.

### Task 1.1: Fix the `BodyInit` hole on the Fetch path

**Skills:** `@superpowers:test-driven-development`

**Files:**
- Modify: `src/http/web.ts`
- Test: `test/` (the Fetch adapter suite)

Gitea #19 reports, from a real `deno publish --dry-run`:

```
TS2345: Argument of type 'string | Buffer<ArrayBufferLike> | null' is not
assignable to parameter of type 'BodyInit | null | undefined'.
  --> src/http/web.ts:112:23
```

`Buffer` is not a valid `BodyInit` under Deno's lib. It works at runtime because implementations are forgiving, which is what makes it worth fixing before a user reports it as a bug: it is a genuine typing hole on the runtime-agnostic path, not a JSR formality.

**Step 1:** Write a failing test that drives a `Buffer` body through the Fetch adapter and asserts the response body round-trips byte-for-byte.

**Step 2:** Narrow the body to a real `BodyInit` at the boundary — convert the `Buffer` to a view its type declares, rather than casting the error away. A cast would keep the hole and hide it.

**Step 3:** Confirm the test passes and `npm run typecheck` is clean.

### Task 1.2: Give the slow-type sites explicit return types

**Files:**
- Modify: `src/metadata.ts` (11 sites)
- Modify: `src/params.ts` (6 sites)

Two shapes, both mechanical: `missing-explicit-return-type` on factory functions (`routeDecorator` at `src/metadata.ts:103`, `envelope` at `src/params.ts:35`) and `missing-explicit-type` on the exported constants built from them (`export const Get = routeDecorator('GET', 'buffer')` at `src/metadata.ts:126`).

**Do not pass `--allow-slow-types`.** That flag degrades generated declarations and makes type checking 1.5–2× slower for consumers, in the framework whose central claim is type safety. Shipping it would contradict the pitch on its own install page.

**Step 1:** Annotate the factories first — several of the constant errors resolve on their own once the factory's return type is written down.

**Step 2:** Annotate whatever constants remain.

**Step 3:** `deno publish --dry-run` reports zero slow types, with no flags.

**Verify:** `npm run typecheck` and `npm test` still clean; the public types in `dist/` are unchanged or strictly more precise.

### Task 1.3: Runtime matrix in CI

**Files:**
- Modify: `.github/workflows/ci.yml`

The suites exist and CI ignores them. Add a matrix job that runs `test:deno`, `test:bun` and `test:edge` alongside the Node build.

**Step 1:** Add a job with the three runtimes, each installing its own toolchain. Keep it a separate job from `build` so a Bun failure reports as a Bun failure and does not bury the Node lint output — the same reasoning `ci.yml:53` already applies to the audit step.

**Step 2:** Confirm the forge difference documented at `AGENTS.md:73` does not bite: GitHub reads `pull_request` workflows from the base branch, so this workflow change cannot validate itself and must reach the base before it gates anything.

**Step 3:** Publish the resulting capability matrix. `README.md:273` already claims all four runtimes; the matrix is what turns that claim into evidence.

**Verify:** A deliberate break in shared code fails the Deno job and not only the Node one.

### Task 1.4: Claim the JSR scope and publish

**Files:**
- Modify: `deno.json`
- Modify: `.github/workflows/release.yml`

**Blocked on Diego and not delegable:** `@green-tea` on jsr.io must be claimed with a GitHub account.

**Step 1:** Add `name`, `version` and `exports` to `deno.json`. Decide whether all four entry points (`.`, `./deno`, `./bun`, `./edge`) are exported or only the Deno one.

**Step 2:** Publish from the same `v*` tag that publishes to npm, using GitHub Actions OIDC. `release.yml` already holds `id-token: write` for npm Trusted Publishing, so JSR needs no new secret.

**Step 3:** Nothing here justifies cutting a release on its own — it rides along with the next version cut that has a reason.

---

## Phase 2: The shutdown cluster

Four open issues, all consequences of the `close({ timeoutMs })` contribution that just merged (`3dcf784`). Treated as one deliverable because they are one subject: Trust Release §14 (P1, lifecycle guarantees) and CTO P0-4 (production checklist, shutdown).

Order matters — the bug first, then the API, then the docs that describe the finished API.

### Task 2.1: #20 — `finish()` reads its timer before declaration

A use-before-declare bug. Smallest item in this plan and it is already shipped. Fix it, and leave a test that fails if the ordering regresses.

### Task 2.2: #19 — shutdown deadline settable at `createApp` level

The 10s deadline is hardcoded. Make it configurable at app level, with `close({ timeoutMs })` still overriding per call.

Per `AGENTS.md:81`, a new option on a public interface **must** also change `src/app/types.ts`. An implementation that grows a parameter alone is unreachable for anyone consuming the package.

### Task 2.3: #15 — graceful shutdown is Node-only — **DECIDED, DONE**

**Decision: `app.close()` stays Node-only; each adapter that owns a server offers the same `close({ timeoutMs })`.** The framework's line is *it handles architecture, you handle business*, and draining is owned by whoever holds the handle.

What the runtimes turned out to allow, measured rather than assumed:

| Runtime | Drain | After the deadline |
|---|---|---|
| Node | `server.close()` | `closeAllConnections()` — remainder cut |
| Bun | `stop(false)` | `stop(true)` — remainder cut |
| Deno | `shutdown()` | **returns anyway** — remainder ends with the process |

Deno cannot escalate. Aborting the serve signal while `shutdown()` is pending throws `BadResource: Bad resource ID` from Deno's own listener — uncaught, and fatal under `deno test`. Measured on Deno 2.9: abort alone is clean, abort after shutdown is not. So on Deno the deadline bounds how long `close()` waits, not when connections die, and `runtimes.md` says so in a table rather than averaging the three.

`closeWithDeadline` (`src/http/shutdown.ts`) is shared so the two adapters cannot drift into different meanings of the same `timeoutMs`, and it resolves on its own timer rather than awaiting the force call — Bun's `stop(true)` was measured waiting out a handler with a pending timer, which is the unbounded wait the deadline exists to prevent.

### Task 2.5: Shutdown as an extension point — **OPEN, needs its own design**

Raised while deciding #15: shutdown should emit signals so plugins and providers register their own teardown, instead of every consumer writing `process.on('SIGTERM', …)` by hand. Same principle as the decision above — the framework owns the plumbing.

It does **not** fit the existing `Bus`, and that is the finding worth carrying forward. `Bus.on` takes a synchronous listener (`src/bus.ts:29`) and `emit` neither awaits nor surfaces failures (`src/bus.ts:38`, `catch {}`). That is deliberate — observers must never break the pipeline — but a plugin closing a database connection needs shutdown to *wait for it*. Registering a teardown is not observing an event, and bending `Bus` to do both would cost the guarantee that makes it safe.

So it needs: an await-aware teardown registry, a new surface on `PluginApi` (public API — `src/plugin.ts:19`), and a decision about provider cleanup. That is Trust Release §14 "Graceful lifecycle guarantees" and CTO P0-4, and it belongs in a design document rather than inside a bug-fix cluster. Sequence it with Phase 3, whose observability contract shares the same lifecycle vocabulary.

### Task 2.4: #18 — docs still describe `close()` without the timeout

Last, so it documents the finished API rather than being rewritten twice. If Phase 4 has already run, this lands in the docs repository instead.

---

## Phase 3: Observability (#10)

The one every report puts first, and the only one that needs a design document before code.

### Task 3.1: Design document

**Files:**
- Create: `.specs/2026-XX-XX-green-tea-observability-design.md`

Write the design before any implementation, following the design/plan pairing already in `.specs/`.

The issue is explicit that this is **one design, not six**: an injectable logger, structured output and tracing hooks are the same API decision, and solving them separately leaves three mechanisms that do not fit together.

Inputs to reconcile:

- The scope in GH #10 — injectable logger contract, JSON default with human-readable dev output, request/response logging as a composable step rather than global middleware, hooks an exporter can attach to, metrics export.
- The Trust Release event vocabulary (§4) — `request.*`, `route.*`, `step.*`, `provider.*`, `graph.*`, `websocket.*`, `stream.*` — and its context fields (`requestId`, `traceId`, `route`, `transport`, `step`, `duration`, `status`, `scope`, `runtime`).
- Trust Release §6, graph timing. Per-step timings are close to free because the graph already knows every node, but the instrumentation stays opt-in if overhead is measurable. Measure before deciding.

Hard constraint, restated from `AGENTS.md:11`: **no new runtime dependency.** Core stays on `reflect-metadata` alone. An OpenTelemetry exporter is a separate package (`@green-tea/opentelemetry`), never a core dependency.

Decisions the design must settle rather than leave open:

1. Is the logger a provider like any other, or a distinct registration?
2. Do events go through one emitter or through per-category hooks?
3. Does a step failure emit `step.failed` and `request.failed`, or only the outer one?
4. Do long-lived streams and WebSockets emit per-message events, or only lifecycle ones? (The same reasoning that keeps upgrades out of the #21 gate applies.)

### Task 3.2: Implement to the approved design

Do not start before the design is reviewed. Write the implementation plan from the approved design, as `.specs/` already does for every other subsystem.

### Task 3.3: Rewrite the observability paragraph in `README.md`

`README.md:246` currently reads "**No observability layer, either.**" and points at issue #10. When #10 lands, that paragraph is wrong and it is the single most load-bearing sentence in the CTO's assessment. Rewriting it is part of the work, not follow-up.

`AGENTS.md:83`: new public API needs a note in `README.md`.

---

## Phase 4: Split the documentation site

Verified before scheduling: `website/` is self-contained. 26 source files, no path escaping the directory, and the `@green-tea/core` mentions inside the `.md` files are example code, not build-time imports.

The coupling to core is five lines:

| Location | What |
|---|---|
| `.github/workflows/ci.yml:62-65` | `npm ci --prefix website`, `npm audit --prefix website`, `npm run docs:build` |
| `package.json:100-101` | `docs:dev`, `docs:build` |

Plus two README references to update: `README.md:254` (the docs link) and `README.md:263` (`npm run docs:dev`).

**The real work is not the move.** No workflow anywhere in `.github/workflows/` deploys the site. `website/astro.config.mjs:6` points at `green-tea.expressive-tea.io` and the deploy happens by hand today. The new repository is where that pipeline gets built for the first time.

### Task 4.1: Create the repository and move `website/` with its history

Preserve commit history for the moved directory rather than landing it as one squashed import.

### Task 4.2: Build the deploy pipeline

The thing the docs never had. Build on push to the default branch, deploy to `green-tea.expressive-tea.io`.

### Task 4.3: Remove the website from core

Delete the three `ci.yml` steps, the two `package.json` scripts, and `website/`. Update `README.md:254` and `README.md:263`.

### Task 4.4: Guard the seam the split opens

The split trades CI coupling for drift risk: docs and code can now disagree without anything failing. #18 exists precisely because docs fell behind an API change. Decide what catches that — a link check against the published package, a docs job triggered from core releases, or an explicit accepted risk written down. Do not leave it unstated.

**Resolved 2026-08-17: accepted risk, stated where the rule is read rather than where it is published.** The first pass put it in both READMEs and stopped there, which satisfies the letter of "do not leave it unstated" and little else — the core README's copy sits in *Docs & development*, a section a user reads and a contributor changing an API does not.

What governs behaviour is `AGENTS.md:83` and the pre-PR checklist in `CONTRIBUTING.md`, both of which already carried *"New public API needs a note in `README.md`"* — written before the split and never updated for it, so the two documents that a contributor (or an assistant) actually reads mid-change said nothing about the new repository. Both now name it and say why the rule exists, since a rule without its reason is the first one dropped under time pressure.

**The link check was prototyped and then rejected, on measurement rather than taste.** It had been recommended here as the one worth building; building enough of it to decide showed otherwise.

- Every symbol the pages import is real: **24 distinct imports from `@green-tea/core` across 25 pages, all present** among the package's 101 exports. No bug for it to find today.
- More decisively, **an import check could not have caught #18**. That issue was *"docs still describe `close()` without the timeout"* — the method existed; the **option** was undocumented. Imports are the part that does not drift. Options, option shapes and method signatures are.
- Extending it to options and methods was tried and produced **17 findings, all 17 false** — a regex cannot tell a nested `tls: { key, cert }` from a top-level option, `app.example.com` in a CORS example from an `app.*` call, or prose describing Express's `app.use()` from a green-tea API. A check with that signal-to-noise trains people to ignore it, which is worse than not having one.
- What would genuinely catch #18's class is **type-checking the code blocks** (twoslash / Expressive Code). That requires the documentation repository to depend on `@green-tea/core` and its examples to be complete and compilable — many are deliberately fragments. It buys the guarantee back by spending exactly the independence this split was for.

So the accepted risk stands, now as an informed choice rather than a default. A **docs job triggered from core releases** was the other option and remains the weaker one: it fires after the API has already shipped.

One page is covered by more than a rule: `test/circuit-breaker-recipe.test.ts` executes the recipe published in `guides/circuit-breaker.md`. That is one page of twenty-five, and is not a substitute for the check above.

---

## Phase 4.5: Move the JSR gate off the tag — **run this before Task 2.5's code**

Numbered as an insertion because that is what it is, the same way Task 2.5 was. It is small, and its position is the whole point: **Task 2.5 adds public API** — `Hooks`, `TeardownFn`, `PluginApi.onShutdown` — and exported types are exactly what JSR's slow-types check polices. Writing that surface with no JSR gate on pull requests means learning at release time whether the shape is publishable.

Verified before writing this, because the first reading was wrong: `release.yml:42` **already** runs `deno publish --dry-run`, before publishing to either registry, and its comment already makes the argument — *"JSR checks things npm never looks at — slow types, module analysis — and learning about them after npm has published leaves the tag half-shipped."* Phase 1 already published to JSR, and a dry run passes today, slow-types check included.

The gap is not that the gate is missing. It is **when it runs**: only on a version tag. A change that breaks Deno's type-checker or introduces a slow type lands on `main` in silence and surfaces while cutting a release — the moment `release.yml`'s own npm-audit comment identifies as having the least time to judge a fix. The workflow makes that argument for advisories and not for JSR.

Worth stating plainly: `deno publish --dry-run` type-checks the four entry points with **Deno's** checker and lib, which is not the same pass as `tsc --noEmit -p tsconfig.json`. A second compiler over the same source is a real gate, not a formality — Task 1.1 exists because that second compiler found a hole the first one did not. And JSR serves `src/` directly, so anything it would reject is something a JSR user gets.

### Task 4.5.1: Run the JSR gate on every push and pull request

**Files:**
- Modify: `.github/workflows/ci.yml`

Add `deno publish --dry-run` to the `runtimes` job's Deno leg, which already installs Deno. Measured at **0.68s** against 2.0s for the whole vitest suite — cheap enough that placing it anywhere else is over-thinking.

Leave `release.yml` alone. The tag-time gate stays: it is the one that protects an immutable JSR version, and a gate that runs twice is not a duplication worth removing.

### Task 4.5.2: One command for the whole matrix

**Files:**
- Modify: `package.json`
- Modify: `README.md`

`npm test` is Node-only, deliberately — it is the fast local loop, 2s, and booting Deno, Bun and workerd into it would tax every run to catch what CI already catches on every push. The `runtimes` job means these suites are not unguarded; what is missing is a way for a contributor to run everything with one command before pushing.

Add `test:all` — `npm test` plus `test:deno`, `test:bun`, `test:edge`, and the JSR dry run. Say in `README.md` which one is the fast loop and which one is the pre-push check, so the split reads as a decision rather than an oversight.

### The decorator warning is expected — no task, and no new documentation

Every `deno publish --dry-run` prints:

```
Warning experimentalDecorators compiler option is deprecated and may be removed at any time
```

Whoever adds this gate to CI will see that warning arrive with it and should not treat it as something the gate found. It is **already documented, and better than a new note would manage**: `README.md:233` (*Why legacy decorators*) and `concepts/the-graph.md:43` in the docs repository both carry the reasoning — parameter decorators are deliberately absent from the TC39 Stage 3 proposal, so `handler(@param('id') id: string)` is only expressible with legacy decorators, and Stage 3 means the replacement is not finalized either.

An earlier draft of this phase claimed the framework "depends on `emitDecoratorMetadata`". That is **wrong**, and both documents already say so: argument positions are recorded explicitly, and `grep -rn 'design:type\|design:paramtypes' src/` returns nothing — the flag is set in `tsconfig.json` and `deno.json`, but no `design:*` reflection is read anywhere. Legacy parameter decorators are the only legacy surface this project actually depends on.

Do not turn the warning into an error to force the issue: that breaks releases on someone else's schedule.

---

## Phase 5: Close #13 as documentation

### Task 5.1: Write the circuit-breaker recipe

**Files:**
- Create: a guide page in the docs repository

The issue was opened to decide placement, not to commit to a core implementation, and it answers itself: core adding resilience policy would contradict the one-runtime-dependency rule. A circuit breaker fits a step — it needs whatever provides the client, it produces a guarded caller, and the graph already sequences it correctly.

Write it as a worked example, then close #13 pointing at the page. First real content in the new repository, which is also a live test of the deploy pipeline from Task 4.2.

---

## Phase 6: The stability contract

### Task 6.1: A stability paragraph in `Honest scope`

**Files:**
- Modify: `README.md`

Not a roadmap, and not the API freeze. A statement of which areas are volatile *today* — present state, no dates, no delivery commitment. This is spare-time work by one person and a roadmap it cannot keep would cost more trust than it earns.

`## Honest scope` (`README.md:240`) already carries exactly this voice: mesh is alpha, there is no observability layer, runtimes differ in what they can offer. The stability tiers belong in that section, in that register, as one paragraph.

Roughly the split the Trust Release report proposes in §8 — graph semantics, providers, steps and controllers as the stable candidates; decorator syntax, CLI and plugin APIs as beta; mesh and distributed capabilities as experimental. Verify each claim against the code before writing it down; a stability tier asserted and then broken is worse than none.

`README.md:266-276` keeps its `**next**` line unchanged. API freeze stays declared there and gets planned separately, near the RC.

---

## Verification

Per `AGENTS.md:28`, run before proposing any task as finished:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

And from Phase 1 onward the runtime suites are no longer optional, because CI runs them:

```bash
npm run test:deno && npm run test:bun && npm run test:edge
```

Conventional Commits focused on the *why*, every commit signed off (`git commit -s`), no AI co-authoring attribution.
