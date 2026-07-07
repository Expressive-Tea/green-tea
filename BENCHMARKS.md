> **TL;DR**: `raw-http` posted the highest median req/s in the first benchmarked scenario on this box — see the single-box caveat below before reading anything into the absolute numbers.

# green-tea Benchmarks

## Environment

- **Date**: 2026-07-07
- **Commit**: daa13f6
- **Node**: v22.22.2
- **OS**: darwin
- **CPU**: Apple M4 Max (16 cores)
- **RAM**: 69 GB
- **Core-pinned**: no
- **autocannon config**: 100 connections, 5s duration, 3 runs (1 warmup discarded), pipelining 1

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
| raw-http | 116,166 | 0.00 | 1.00 | 1.00 | 0.6% | 115,590–117,242 |
| green-tea | 97,760 | 0.00 | 1.00 | 2.00 | 0.3% | 97,094–97,837 |
| fastify | 86,470 | 1.00 | 2.00 | 2.00 | 0.3% | 86,202–86,829 |
| express | 24,005 | 3.00 | 6.00 | 9.00 | 0.3% | 23,989–24,136 |

### Route param

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 117,024 | 0.00 | 1.00 | 1.00 | 0.3% | 116,538–117,242 |
| green-tea | 92,384 | 1.00 | 2.00 | 2.00 | 0.5% | 91,795–92,998 |
| fastify | 85,754 | 1.00 | 2.00 | 2.00 | 0.3% | 85,651–86,317 |
| express | 23,666 | 4.00 | 5.00 | 8.00 | 0.1% | 23,666–23,720 |

### Pipeline (3 steps) (approximation)

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 114,157 | 0.00 | 1.00 | 1.00 | 0.2% | 113,862–114,554 |
| fastify | 84,320 | 1.00 | 2.00 | 2.00 | 0.1% | 84,269–84,422 |
| green-tea | 83,962 | 1.00 | 2.00 | 2.00 | 0.4% | 83,590–84,358 |
| express | 23,829 | 4.00 | 5.00 | 8.00 | 0.1% | 23,768–23,851 |

### POST JSON + validation

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 100,230 | 0.00 | 1.00 | 2.00 | 0.1% | 100,064–100,294 |
| green-tea | 76,243 | 1.00 | 2.00 | 2.00 | 0.2% | 76,192–76,550 |
| fastify | 63,222 | 1.00 | 2.00 | 3.00 | 0.7% | 62,307–63,229 |
| express | 19,870 | 4.00 | 7.00 | 23.00 | 0.3% | 19,758–19,883 |

## Step-scaling (green-tea)

| Path | Steps | req/s |
| --- | --- | --- |
| /steps/0 | 0 | 91,386 |
| /steps/3 | 3 | 81,530 |
| /steps/5 | 5 | 72,237 |

Each additional pipeline step costs roughly 3,830 req/s (-21.0% over 5 steps), on this box.

## Cost of secure-by-default (green-tea)

| Label | req/s |
| --- | --- |
| security:false (parity) | 97,760 |
| security:true (default) | 93,306 |

The real cost of running secure-by-default (rather than the parity-mode `security:false` used above) is ~4.6% req/s on this box.

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
