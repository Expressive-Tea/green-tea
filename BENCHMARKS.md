> **TL;DR**: `raw-http` posted the highest median req/s in the first benchmarked scenario on this box — see the single-box caveat below before reading anything into the absolute numbers.

# green-tea Benchmarks

## Environment

- **Date**: 2026-09-02
- **Commit**: 8c5855c
- **Node**: v22.22.2
- **OS**: darwin
- **CPU**: Apple M4 Max (16 cores)
- **RAM**: 69 GB
- **Core-pinned**: no
- **autocannon config**: 100 connections, 10s duration, 5 runs (1 warmup discarded), pipelining 1

> **A note on honesty: this is a single-box benchmark.** All frameworks were driven with autocannon over
> loopback on the same machine, sharing the same cores as the server processes they measured. That
> contention overstates absolute throughput for every framework and compresses the differences *between*
> frameworks — do not read the raw req/s numbers as what you would see on separate client/server hardware.
> The honest takeaway is the **ratio** between frameworks in the same table, not any single absolute
> number. Note also that green-tea runs with `security:false` in the cross-framework tables below, purely
> for response-header parity with the other frameworks (none of which set the same security headers by
> default) — the real cost of running green-tea secure-by-default is measured separately in its own
> section further down.

## Cross-framework scenarios

### JSON hello (overhead)

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 119,357 | 0.00 | 1.00 | 1.00 | 0.4% | 118,560–120,067 |
| nestjs-fastify | 98,039 | 0.00 | 1.00 | 2.00 | 1.2% | 96,073–99,680 |
| fastify | 89,097 | 1.00 | 1.00 | 2.00 | 0.1% | 88,864–89,207 |
| green-tea | 87,473 | 1.00 | 2.00 | 2.00 | 0.3% | 86,903–87,607 |
| express | 24,677 | 3.00 | 5.00 | 8.00 | 0.2% | 24,647–24,769 |
| nestjs-express | 21,879 | 4.00 | 6.00 | 9.00 | 0.2% | 21,845–21,953 |

### Route param

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 120,905 | 0.00 | 1.00 | 1.00 | 0.5% | 119,927–121,713 |
| nestjs-fastify | 91,849 | 1.00 | 1.00 | 2.00 | 0.3% | 91,825–92,599 |
| fastify | 88,317 | 1.00 | 1.00 | 2.00 | 0.2% | 87,997–88,439 |
| green-tea | 86,595 | 1.00 | 2.00 | 2.00 | 0.2% | 86,368–86,880 |
| express | 24,200 | 3.00 | 5.00 | 8.00 | 0.2% | 24,158–24,260 |
| nestjs-express | 21,182 | 4.00 | 6.00 | 9.00 | 0.7% | 21,150–21,518 |

### Pipeline (3 steps) (approximation)

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 118,996 | 0.00 | 1.00 | 1.00 | 0.3% | 118,583–119,584 |
| nestjs-fastify | 89,527 | 1.00 | 2.00 | 2.00 | 1.0% | 87,572–90,028 |
| fastify | 86,671 | 1.00 | 1.00 | 2.00 | 0.1% | 86,490–86,793 |
| green-tea | 80,079 | 1.00 | 2.00 | 2.00 | 0.2% | 80,026–80,375 |
| express | 24,325 | 3.00 | 5.00 | 8.00 | 0.2% | 24,281–24,407 |
| nestjs-express | 20,872 | 4.00 | 6.00 | 9.00 | 0.2% | 20,801–20,940 |

### POST JSON + validation

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 104,288 | 0.00 | 1.00 | 1.00 | 0.4% | 103,776–104,916 |
| green-tea | 70,298 | 1.00 | 2.00 | 3.00 | 1.0% | 68,972–70,607 |
| fastify | 65,905 | 1.00 | 2.00 | 3.00 | 0.3% | 65,725–66,367 |
| nestjs-fastify | 63,318 | 1.00 | 2.00 | 3.00 | 0.9% | 62,454–63,747 |
| express | 20,297 | 4.00 | 6.00 | 10.00 | 0.5% | 20,158–20,414 |
| nestjs-express | 18,788 | 5.00 | 7.00 | 10.00 | 0.3% | 18,684–18,862 |

## Step-scaling (green-tea)

| Path | Steps | req/s |
| --- | --- | --- |
| /steps/0 | 0 | 88,108 |
| /steps/3 | 3 | 79,951 |
| /steps/5 | 5 | 74,127 |

Each additional pipeline step costs roughly 2,796 req/s (-15.9% over 5 steps), on this box.

## green-tea across runtimes

| Scenario | node | deno | bun |
| --- | --- | --- | --- |
| JSON hello (overhead) | 90,976 | 153,408 | 131,674 |
| Route param | 88,905 | 146,368 | 126,909 |
| Pipeline (3 steps) | 82,045 | 136,256 | 117,489 |
| POST JSON + validation | 72,236 | 106,662 | 95,124 |

Same application, same built bundle, same box — only the runtime differs. Read across a row, never against the cross-framework tables above: those measure other frameworks on Node, and nobody ran fastify on Bun here. A runtime that is not installed is absent rather than zero.
## Cost of secure-by-default (green-tea)

| Label | req/s |
| --- | --- |
| security:false (parity) | 87,473 |
| security:true (default) | 83,773 |

The real cost of running secure-by-default (rather than the parity-mode `security:false` used above) is ~4.2% req/s on this box.

> Scope: this micro-bench currently measures the security-**headers** cost only (`security:false` vs
> `security:true` on `/hello`). The incremental cost of `@body` validation and CORS is not separately
> measured yet (deferred) — so this table is narrower than the design spec's 4-point plan.

## Methodology

- **Parity controls**: every framework is configured for the fairest possible comparison —
  security-header parity (matching header sets across frameworks, or green-tea running with
  `security:false` in the cross-framework tables), keep-alive parity, and Express's `etag` and
  `x-powered-by` disabled. The `/validate` scenario always sends a valid body so every framework
  takes its success path and performs equivalent validation work.
- **Pipeline approximation**: scenarios marked `(approximation)` (e.g. the multi-step pipeline route)
  do not have an exact one-to-one equivalent in every framework; the closest reasonable approximation
  is used for each framework and the result should be read as indicative, not as an exact apples-to-apples
  measurement.
- **Serialization parity**: all four frameworks serialize their JSON responses with plain
  `JSON.stringify` in these benchmarks. Fastify's `fast-json-stringify` response serializer is
  deliberately **not** engaged — only its input `schema.body` validation is used — so no framework
  gets a serialization fast path the others lack.
- **Content-type charset asymmetry (disclosed, not controlled)**: green-tea and raw-http send
  `Content-Type: application/json` while Express and Fastify send `application/json; charset=utf-8`.
  This is a minor header-byte asymmetry that is disclosed here rather than normalized away.
- **NestJS runs on an underlying adapter** (Express or Fastify): the `nestjs-express` / `nestjs-fastify`
  rows measure Nest's DI / decorator / routing overhead **on top of** that adapter, so compare each
  against its own base (`express` / `fastify`) rather than against the field. Nest's idiomatic
  `ValidationPipe` / class-validator is **not** used — `/validate` performs the same manual field check
  as every other server (parity). The same parity controls apply: `etag` and `x-powered-by` are disabled
  on the underlying Express instance, and `keepAliveTimeout` is 5000 on both adapters.

<!-- keep-below: hand-written, survives `npm run bench` -->

## What moved between releases

These figures were measured per function and never per version. Every change on the request path
was benchmarked as it landed — the numbers are still in the code, cited below — but no one ran this
file between `26.7` and `26.9`, so nothing added them up. That is the gap this section and
`npm run bench:compare` exist to close.

### The release gate: `26.8.0-beta.1` → `26.9.0-beta.1`

Both trees measured on one box in one sitting, alternating which side ran first each round, sharing
one `node_modules` and one byte-identical server file. Medians of five rounds:

| Scenario | 26.8.0-beta.1 | 26.9.0-beta.1 | Δ |
| --- | --- | --- | --- |
| hello | 91,343 | 90,371 | −1.1% |
| param | 88,113 | 87,921 | −0.2% |
| pipeline (3 steps) | 80,934 | 80,893 | −0.1% |
| validate (POST) | 72,340 | 72,241 | −0.1% |
| hello + security | 85,967 | 86,426 | +0.5% |
| hello + cors predicate | 82,609 | 83,401 | +1.0% |
| preflight + cors predicate | 112,055 | 115,069 | **+2.7%** |

Every row but the last overlaps between the two sides and is noise. The preflight row does not: the
new tree wins all three rounds, which is where a `cors.origins` predicate stopped being evaluated
three times per request.

That change is a call count, not a rate, and the benchmark's predicate is a `Set` lookup — so the
saving is invisible in req/s here and would be two or three network round trips in the lookup the
option exists for:

| | per cross-origin GET | per preflight |
| --- | --- | --- |
| 26.8.0-beta.1 | 2 | 3 |
| 26.9.0-beta.1 | **1** | **1** |

### Against `26.7`, and why it is not a regression

The table this file carried until today was measured at `fe1831a`, before `26.8.0-beta.1`
shipped. Re-running
that tree today, under the same toolchain and dependencies, gives 94,403 req/s on `hello` and
93,361 on `param` against 89,527 and 85,839 for the current tree — roughly −5% and −8%. Against
`fastify` as a control, which moved +1.2% to +1.8% across the same scenarios, green-tea's ratio to
it fell 6.6% to 11.7%.

**That number is real and it is not a regression, because it is not the same program.** July matched
routes by splitting the path and comparing segments, returning on the first hit, in one flat file.
It had no route constraints, no specificity ranking, no per-request correlation, no lifecycle
stream, and one adapter. It was fast the way something is fast before it does anything.

What the interval bought, in the order it costs: a runtime-neutral request and response boundary,
which is what serves Deno, Bun and workerd from one core rather than one adapter; constraint and
specificity matching; a correlated event stream; and per-request identity.

The first of those is now measurable, because the runtimes table above did not exist either. The
same boundary that costs on Node is what puts the same application on Deno at 153,408 req/s and Bun
at 131,674 against Node's 90,976 — and above the 119,357 that Node's own `http` module manages with
no framework at all. Whether the trade is worth it is the reader's call. This file's job is to say
what it cost and what it bought.

### Figures recorded when each change landed

Measured at the time, in the code, against a microbenchmark rather than this harness:

| Where | Finding |
| --- | --- |
| `src/http/core.ts:63` | a per-request derivation that reached **45% of a whole request** before it was fixed |
| `src/http/core.ts:89` | six request-id generators compared; `crypto.randomUUID` at 76 ns was the fastest cross-runtime option, and the only alternatives that beat it are Node-only |
| `src/http/core.ts:229` | wrapping `dispatch` in a second async frame: 0.43 µs per request |
| `src/bus.ts:173` | spreading request identity into an event payload: ~197 ns on a two-step pipeline |
| `src/pipeline.ts:58` | one timestamp per step boundary instead of two: 25.2 ns against 45.3 ns per step |
| `src/http/headers.ts:30` | 146.4 ns against 55.9 ns for the same header answer |
| `src/http/body.ts:39` | 250 ns per request for a closure and the error context it captured |
| `src/http/router.ts:232` | per-segment decoding on a path nobody decodes: 95.8 ns for `/hello`, 342.7 ns for six segments |

**These do not add up to the release delta, and cannot.** They cite different baselines — 4.4 µs,
4.5 µs, 10.19 µs — because each was taken against whatever a request cost on the day. A dozen
findings in nanoseconds against inconsistent references is a discussion, not a total. A version-level
number measured against a fixed baseline is what was missing, not rigour.

### What is still unattributed

Three candidates for the `26.7` → `26.9` interval were measured and none of them account for it:

- **`crypto.randomUUID` per request** — removing it entirely lands within noise on every scenario,
  and one row moves the wrong way. At 76 ns against a ~11 µs request it is ~0.7%, below what a load
  test at this CV can resolve.
- **Specificity ranking in the matcher** — replacing it with July's first-match-wins is noise on all
  four rows at this route-table size.
- **The bundle versus the TypeScript source** — every row overlaps, so the form the table loads does
  not explain it either.

No single culprit was found. The remaining candidates are the neutral request and response objects
and the several small per-request allocations around them, which is a shape that resists a single
measurement.

## What this file does not measure

- **Route-table width was invisible until `26.9`.** Every matcher cost scales with how many
  candidates a request walks past, and the cross-framework tables use six routes — so any matcher
  change measures as noise there regardless of its size. `npm run bench:compare` carries 50- and
  200-route cases for this reason. Settling route ranking when the table is built rather than per
  request is worth nothing at six routes, +3.4% at fifty, and **+12% to +14.9% at two hundred**,
  across twelve rounds without a crossing sample.
- **Boot time is absent.** Independent providers began booting concurrently in `26.9`: three
  providers with no edges and 200 ms of work each went from 616 ms to 210 ms. No table here shows it.
- **Streaming is absent.** Every scenario is a buffered response. SSE framing, the encoder's
  per-item work, and the stream lifecycle events are not exercised.
- **The cross-framework tables are Node-only**, and they load green-tea from `src/` through `tsx`
  while the other frameworks load their published JavaScript. Measured today, that difference is
  within noise — but it is a difference, and the runtimes table above avoids it by loading the built
  bundle on all three.
- **The runtimes table compares each runtime's HTTP server, not its JavaScript engine.** `Deno.serve`
  and `Bun.serve` are native stacks; Node's `http` is JavaScript. "green-tea on this runtime" is the
  claim, and it is the one an application actually experiences.
