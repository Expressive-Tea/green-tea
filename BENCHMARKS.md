> **TL;DR**: `raw-http` posted the highest median req/s in the first benchmarked scenario on this box — see the single-box caveat below before reading anything into the absolute numbers.

# green-tea Benchmarks

## Environment

- **Date**: 2026-07-07
- **Commit**: 926ca39
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
| raw-http | 115,398 | 0.00 | 1.00 | 1.00 | 0.4% | 115,078–116,077 |
| green-tea | 98,912 | 0.00 | 1.00 | 2.00 | 0.5% | 98,835–99,962 |
| fastify | 85,882 | 1.00 | 2.00 | 2.00 | 0.3% | 85,382–86,074 |
| express | 24,126 | 3.00 | 5.00 | 8.00 | 0.1% | 24,072–24,158 |

### Route param

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 115,437 | 0.00 | 1.00 | 1.00 | 0.3% | 115,245–116,013 |
| green-tea | 93,114 | 1.00 | 2.00 | 2.00 | 0.1% | 92,947–93,126 |
| fastify | 85,805 | 1.00 | 2.00 | 2.00 | 0.2% | 85,498–85,856 |
| express | 23,739 | 4.00 | 5.00 | 8.00 | 0.1% | 23,694–23,778 |

### Pipeline (3 steps) (approximation)

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 114,016 | 0.00 | 1.00 | 1.00 | 0.1% | 114,003–114,157 |
| green-tea | 84,230 | 1.00 | 2.00 | 2.00 | 0.5% | 84,179–85,050 |
| fastify | 83,808 | 1.00 | 2.00 | 2.00 | 0.1% | 83,770–83,898 |
| express | 23,758 | 4.00 | 5.00 | 8.00 | 0.1% | 23,720–23,778 |

### POST JSON + validation

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 99,014 | 0.00 | 1.00 | 2.00 | 0.3% | 98,438–99,181 |
| green-tea | 76,486 | 1.00 | 2.00 | 2.00 | 0.2% | 76,397–76,691 |
| fastify | 63,869 | 1.00 | 2.00 | 3.00 | 0.3% | 63,837–64,323 |
| express | 19,986 | 4.00 | 7.00 | 26.00 | 0.4% | 19,886–20,069 |

## Step-scaling (green-tea)

| Path | Steps | req/s |
| --- | --- | --- |
| /steps/0 | 0 | 92,858 |
| /steps/3 | 3 | 81,658 |
| /steps/5 | 5 | 71,968 |

Each additional pipeline step costs roughly 4,178 req/s (-22.5% over 5 steps), on this box.

## Cost of secure-by-default (green-tea)

| Label | req/s |
| --- | --- |
| security:false (parity) | 98,912 |
| security:true (default) | 93,178 |

The real cost of running secure-by-default (rather than the parity-mode `security:false` used above) is ~5.8% req/s on this box.

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
