# Observability — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Design:** [2026-08-16-observability-design.md](./2026-08-16-observability-design.md) — reviewed, D1–D8 settled. Do not re-decide them here.

**Goal:** Make the existing event stream correlatable and measured, then build the logger on top of it as its first consumer. Closes [#10](https://github.com/Expressive-Tea/green-tea/issues/10).

**Architecture:** Most of this lands in `src/bus.ts` and `src/pipeline.ts`. The `Bus` already has 19 emission points; this adds identity, timing and the request-level events those points had nothing to hang from. No new runtime dependency — `reflect-metadata` stays the only one, and the OpenTelemetry bridge lives outside core.

**Tech Stack:** TypeScript, Vitest, Deno/Bun/workerd suites, `performance.now()`, `crypto.randomUUID()`.

---

## Order

Tasks 1–3 are the correction; 4–6 are what consumes it. Do not start 4 before 3 — a logger built on uncorrelated events would need its own notion of request identity, which is the failure the design exists to prevent.

---

### Task 1: Give every request an identity, and carry it

**Skills:** `@superpowers:test-driven-development`

**Files:**
- Modify: `src/http/core.ts` (`NeutralRequest`, `handle`)
- Modify: `src/http/server.ts` (~line 120, the Node call into `handle`)
- Modify: `src/http/web.ts` (~line 178, the Fetch call into `handle`)
- Modify: `src/bus.ts`
- Test: `test/observability.test.ts` (new)

**Step 1:** Extend `EventPayload` with the optional fields from the design: `requestId`, `traceId`, `route`, `method`, `transport`, `status`, `runtime`. All optional — boot and mesh events have no request to name.

**Step 2:** Add `requestId` to `NeutralRequest` (`src/http/core.ts`). Generate it in the **adapters**, not in `handle()`, and here is why that placement matters: both adapters read and size-check the body before they reach `handle()` (`server.ts:107`, `web.ts:143` per the #21 analysis), so a 413 is rejected before `handle()` ever sees the request. Generating inside `handle()` would leave exactly the failures an operator most wants to correlate without an id.

**Step 3:** One shared helper for generation, so the two adapters cannot diverge on the rule: adopt an incoming `x-request-id`, otherwise `crypto.randomUUID()`. Carry `traceparent` through as `traceId` **without parsing it** (D5).

**Step 4:** Write the test that fails first: fire two concurrent requests through `app.fetch`, collect `request:step:enter` from the bus, and assert every event carries a `requestId` and that the two requests' events never share one. This is the defect the whole design exists to fix, so it is the first test.

**Verify:** `crypto.randomUUID` on Node 18 — CI's `build` job pins `node-version: '18'`, and `test:edge` covers workerd. Do not assume; let both run.

### Task 2: Measure steps at their boundaries

**Files:**
- Modify: `src/pipeline.ts` (`runSteps`, ~line 48)
- Test: `test/observability.test.ts`

**Step 1:** Take `performance.now()` once before the loop, then once per iteration — **N+1 timestamps for N steps**, because a step's end is the next step's start. Not two per step. The design measured the difference: 25.2 ns vs 45.3 ns per step (D7).

**Step 2:** Attach `durationMs` to `request:step:leave`. The field has been declared in `EventPayload` since the beginning and written by nothing; this is what makes it real.

**Step 3:** Always on, no flag (D7 — 0.25% of a request, below the benchmark's own 0.3% CV).

**Verify:** a step that sleeps a known interval reports a `durationMs` in that neighbourhood. Assert a range, never an exact value.

### Task 3: Stop losing which step failed

**Files:**
- Modify: `src/pipeline.ts` (`runSteps`, and the catch at ~line 98)
- Test: `test/observability.test.ts`

`request:step:error` currently emits `{ name: 'pipeline' }`, which throws away the one fact it exists to report.

**Step 1:** Wrap each `step.run` inside `runSteps`, emit `request:step:error` with the real step name and `scope`, and rethrow unchanged. Do not swallow.

**Step 2:** `runPipeline`'s existing catch now emits `request:failed` instead of a second `step:error` (D3). Both fire for a failing step, deliberately: one marks the span, the other the trace.

**Verify:** a three-step pipeline whose middle step throws emits `request:step:error` naming *that* step, plus exactly one `request:failed`.

### Task 4: The logger contract

**Files:**
- Create: `src/logger.ts`
- Modify: `src/app/index.ts` (`createApp` options; the 6 `console.warn` calls)
- Modify: `src/deno.ts`, `src/bun.ts` (1 `console.warn` each)
- Modify: `src/index.ts` (export the type)
- Test: `test/logger.test.ts` (new)

**Step 1:** Define the interface. Keep it to the levels core actually uses — resist inventing a hierarchy nobody calls.

**Step 2:** Default implementation: structured JSON, human-readable when the process is interactive, decided **once at boot** rather than per call. It writes through `console`; core gains no logging dependency (D1).

**Step 3:** `createApp({ logger })`. A distinct registration, not a provider — it has to outlive the graph to report the graph failing to boot (D1). Per `AGENTS.md`, a new public option means `src/app/types.ts` too if it appears on `App`.

**Step 4:** Replace all 8 `console.warn` calls. `grep -rn "console\." src/` must return nothing afterwards, which is the check #10 actually asks for.

**Step 5:** Expose the logger under an injectable key so steps and handlers reach it with `@needs('logger')`. One object, two access paths, no second implementation.

### Task 5: Request logging as a subscriber

**Files:**
- Modify: `src/logger.ts`
- Test: `test/logger.test.ts`

**Step 1:** Build request logging as `bus.on(...)` over the corrected stream (D8). Composable and removable, which is what #10 means by "a composable step, not a global middleware".

**Step 2:** Wrap the subscriber so a throwing logger falls back to `console`. `Bus.emit` swallows listener failures by design (`src/bus.ts:41`); without the wrapper a broken user logger stops writing and tells nobody. The Bus keeps its guarantee; it just stops paying for it with silence.

**Verify:** a logger that throws on every call still produces output, and the request still succeeds.

### Task 6: The remaining events

**Files:**
- Modify: `src/bus.ts`, `src/http/core.ts`, `src/app/index.ts`

**Step 1:** Add `request:start|end|failed`, `route:matched|unmatched`, `graph:resolved|failed` to `LifecycleEvent`.

**Step 2:** `request:end` fires **when the handler returns**, not when a stream closes (D6). `stream:open`/`close` carry the same `requestId` so a consumer joins them itself.

**Step 3:** `route:unmatched` covers 404 and 405 both — naming it after one outcome would misreport the other.

**Step 4:** `route` on every payload is the **matched pattern**, never the concrete path. A metrics consumer labelling on raw URLs produces unbounded cardinality and takes down the metrics backend; the framework must not hand anyone that shape by default.

### Task 7: Benchmark, and publish the number — **DONE; D7 was wrong in shape**

**Files:**
- Modify: `BENCHMARKS.md`

D7 predicted ~0.25% **per step**, invisible against the harness's own 0.3% CV.

**Measured: +7.0% of the framework's own per-request work** — 4.074 µs → 4.361 µs, medians of five interleaved rounds, ranges not overlapping. About 0.29 µs, or ~2% of a request over a real socket.

The prediction was wrong in **shape**, not only magnitude. Per-step work is skipped entirely when nothing subscribes (`Bus.hasListeners`), so a deep pipeline pays no more than a shallow one; what remains is a **fixed per-request** cost — generating the request id, reading two headers, and the guard checks. "Always on" survives, for a better reason than it was made with: there is nothing per-step left to make optional.

**Three earlier numbers for this were published and all three were wrong**, which is the more useful lesson: −3.9%, then 0.8%, then −6.8%. Each came from a comparison with more than one variable moving.

- The first two were sequential rather than interleaved. The same code measured at the start and end of one session differed by **12%** as the machine warmed, so run order was indistinguishable from effect — one of them even reported the wrong sign.
- The third compared `7bd11bf` against `HEAD`, which differ by observability **and** three performance fixes pulling the other way. It reported their net as if it were one of them.

The number above compares `7bd11bf` against `523e318`, the last commit before those fixes, alternating round by round.

Two regressions were found and fixed by measuring rather than reasoning, both larger than anything the design anticipated:

- **A second `async` frame in `handle()` cost 0.43 µs/request** — a promise and two microtask ticks, an order of magnitude more than the four `Map` lookups it existed to arrange. `handle()` is no longer `async`.
- **A closure allocated per request inside `correlateRequest`** cost 0.16 µs, 45% of the then-remaining overhead, for a helper capturing nothing.

Recorded here because the lesson generalises: on this path, an extra promise costs more than any amount of bookkeeping, and a hot-path prediction reasoned from primitive costs was off by more than 10×.

### Task 8: Documentation

**Files:**
- Modify: `README.md` (the *Honest scope* paragraph at ~line 246)
- Modify: `website/src/content/docs/` — a new observability guide, plus the `createapp` reference table

`README.md:246` currently opens "**No observability layer, either.**" and links to #10. It is the single most load-bearing sentence in the CTO assessment, and rewriting it is part of this work rather than follow-up. Say what now exists and what still does not — the OpenTelemetry adapter is not in core and should not be implied to be.

Per `AGENTS.md`, new public API needs a note in `README.md`.

> If Phase 4 has already moved the site, the guide lands in the docs repository instead.

---

## Out of scope

`@green-tea/opentelemetry`, log shipping, sampling, redaction, W3C Trace Context parsing, and plugin/provider teardown (Task 2.5 in the trust-release plan — an awaited teardown and a non-blocking observer are opposite guarantees).

---

## Verification

```bash
npm run lint && npm run format:check && npm run complexity:check && npm run typecheck && npm test
npm run test:deno && npm run test:bun && npm run test:edge   # all three gate a merge now
npm run bench                                                 # hot-path change
grep -rn "console\." src/                                     # must be empty
```
