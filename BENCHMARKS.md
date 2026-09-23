> **TL;DR**: `raw-http` posted the highest median req/s in the first benchmarked scenario on this box — see the single-box caveat below before reading anything into the absolute numbers.

# green-tea Benchmarks

## Environment

- **Date**: 2026-09-23
- **Commit**: daf0fed
- **Node**: v22.22.2
- **OS**: linux
- **CPU**: AMD Ryzen 7 3700X 8-Core Processor (16 cores)
- **RAM**: 67 GB
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
| raw-http | 41,631 | 2.00 | 3.00 | 4.00 | 0.6% | 41,343–41,974 |
| nestjs-fastify | 32,419 | 3.00 | 4.00 | 6.00 | 0.5% | 32,103–32,583 |
| fastify | 32,170 | 3.00 | 3.00 | 5.00 | 1.3% | 31,236–32,356 |
| green-tea | 29,777 | 3.00 | 6.00 | 7.00 | 0.4% | 29,557–29,873 |
| express | 10,546 | 8.00 | 13.00 | 18.00 | 0.4% | 10,480–10,625 |
| nestjs-express | 9,680 | 9.00 | 15.00 | 21.00 | 0.6% | 9,567–9,739 |

### Route param

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 41,756 | 2.00 | 3.00 | 4.00 | 1.1% | 40,953–42,017 |
| fastify | 31,708 | 3.00 | 4.00 | 5.00 | 0.5% | 31,359–31,847 |
| nestjs-fastify | 29,880 | 3.00 | 4.00 | 6.00 | 0.3% | 29,745–29,961 |
| green-tea | 28,706 | 3.00 | 6.00 | 7.00 | 0.6% | 28,562–29,051 |
| express | 10,376 | 9.00 | 12.00 | 17.00 | 0.4% | 10,364–10,453 |
| nestjs-express | 9,257 | 10.00 | 15.00 | 21.00 | 0.2% | 9,244–9,285 |

### Pipeline (3 steps) (approximation)

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 39,897 | 2.00 | 3.00 | 5.00 | 0.6% | 39,847–40,441 |
| fastify | 31,436 | 3.00 | 4.00 | 6.00 | 0.6% | 31,079–31,563 |
| nestjs-fastify | 29,403 | 3.00 | 4.00 | 6.00 | 0.6% | 29,151–29,689 |
| green-tea | 26,839 | 3.00 | 6.00 | 8.00 | 0.1% | 26,783–26,872 |
| express | 10,365 | 9.00 | 12.00 | 18.00 | 1.3% | 10,171–10,542 |
| nestjs-express | 9,256 | 10.00 | 15.00 | 22.00 | 0.5% | 9,187–9,302 |

### POST JSON + validation

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 31,783 | 3.00 | 5.00 | 6.00 | 0.4% | 31,517–31,825 |
| green-tea | 22,005 | 4.00 | 7.00 | 9.00 | 0.7% | 21,736–22,187 |
| fastify | 20,430 | 4.00 | 8.00 | 9.00 | 0.4% | 20,398–20,601 |
| nestjs-fastify | 18,597 | 4.00 | 8.00 | 11.00 | 0.2% | 18,540–18,658 |
| express | 8,440 | 11.00 | 16.00 | 24.00 | 0.3% | 8,408–8,492 |
| nestjs-express | 7,666 | 12.00 | 18.00 | 26.00 | 0.3% | 7,645–7,703 |

## Step-scaling (green-tea)

| Path | Steps | req/s |
| --- | --- | --- |
| /steps/0 | 0 | 29,196 |
| /steps/3 | 3 | 26,564 |
| /steps/5 | 5 | 25,314 |

Each additional pipeline step costs roughly 776 req/s (-13.3% over 5 steps), on this box.

## green-tea across runtimes

| Scenario | node | deno | bun |
| --- | --- | --- | --- |
| JSON hello (overhead) | 30,379 | 51,888 | 46,300 |
| Route param | 29,204 | 51,786 | 42,788 |
| Pipeline (3 steps) | 27,208 | 50,692 | 39,644 |
| POST JSON + validation | 22,609 | 35,743 | 31,960 |

Same application, same built bundle, same box — only the runtime differs. Read across a row, never against the cross-framework tables above: those measure other frameworks on Node, and nobody ran fastify on Bun here. A runtime that is not installed is absent rather than zero.
## Cost of secure-by-default (green-tea)

| Label | req/s |
| --- | --- |
| security:false (parity) | 29,777 |
| security:true (default) | 28,919 |

The real cost of running secure-by-default (rather than the parity-mode `security:false` used above) is ~2.9% req/s on this box.

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

### The release gate: `26.9.0-beta.1` → `26.9.0-beta.2`

Ten cases, both trees on one box in one sitting, alternating which side ran first each round, sharing
one `node_modules` — the two revisions differ by a version string and nothing else in `package.json`,
so the only thing that moved between the sides is green-tea. Medians of three rounds:

| Scenario | 26.9.0-beta.1 | 26.9.0-beta.2 | Δ | |
| --- | --- | --- | --- | --- |
| hello | 90,615 | 89,853 | −0.8% | overlaps |
| param | 86,956 | 87,572 | +0.7% | overlaps |
| pipeline (3 steps) | 80,061 | 81,504 | +1.8% | overlaps |
| steps5 | 75,436 | 75,238 | −0.3% | overlaps |
| validate (POST) | 70,240 | 73,568 | +4.7% | overlaps |
| hello + security | 83,738 | 84,890 | +1.4% | overlaps |
| hello + cors predicate | 82,237 | 82,528 | +0.4% | overlaps |
| preflight + cors predicate | 111,223 | 114,220 | +2.7% | overlaps |
| param, 50 routes | 83,505 | 87,078 | +4.3% | **flagged** |
| param, 200 routes | 73,289 | 73,335 | +0.1% | overlaps |

Nine rows overlap and therefore say nothing, which is the result this gate exists to produce. The
release is a breaking one — `Plugin` became `{ name, mount }`, `serveDeno()` and `serveBun()` became
async, `@Provider({ export: true })` stopped being a thing a teapot can do, and an `HttpError` is now
recognised by a brand rather than by `instanceof` — but all of that is boot-time or error-path work.
None of it sits on the per-request path these cases walk, and the table agrees.

The tenth row is why "flagged" is not a synonym for "found something". `param, 50 routes` came out
+4.3% with separated ranges, in green-tea's favour, and it did not survive being asked twice: re-run
alone at seven rounds it is **+0.5% and overlapping**, with both sides swinging between 80,794 and
88,259 req/s. The reason to doubt it before re-running was that it had no mechanism — the matcher
work that could produce it would have to show at 200 routes too, and that row had already said
+0.1%. Treat a flagged row as an instruction to measure again, whichever direction it points; a win
nobody can explain is a measurement problem more often than it is a win.

The cross-framework tables above moved to a quiet box for this release, which is why their absolute
numbers are roughly a third of the previous run's: an idle 2019 desktop Ryzen against a laptop M4
Max. Two attempts on that laptop were discarded first, and the reason is worth recording. Each
framework's delta against its own previous number tracked its position in the run order rather than
anything in its code — the one measured second lost 7%, the ones measured last gained — while a
browser and the window server held around 60% of the machine throughout. That run would have read
as green-tea overtaking Fastify, which is the most flattering available reading of a broken
measurement and exactly the kind this file exists to refuse. The gate table above survives the same
contention, because both sides pay it and the order alternates; an absolute cross-framework number
does not.

What survived the move is the shape, and that is the part worth trusting. On both machines green-tea
is behind Fastify on `hello`, `param` and `pipeline` and ahead of it on `validate`, and roughly
2.8× ahead of Express throughout. The *size* of the gap did not survive: against Fastify it is
2-8% on the M4 and 7-15% here. A percentage quoted without the hardware it was measured on is not a
fact about the framework.

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
