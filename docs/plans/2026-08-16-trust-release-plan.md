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

### Task 2.3: #15 — graceful shutdown is Node-only

Decide and implement: either the Fetch adapters honour the deadline, or `close()` says plainly that they do not.

`AGENTS.md:82` governs the fallback: behaviour that differs between runtimes must be explicit. An "unavailable here" is fine; silently accepting an option that does nothing is a bug. Follow the precedent already set for `maxConnections` at `runtimes.md:37`, `src/bun.ts:59` and `src/deno.ts:34`, where the project documented the runtime gap rather than faking parity.

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
