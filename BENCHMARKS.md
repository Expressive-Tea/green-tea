> **TL;DR**: `raw-http` posted the highest median req/s in the first benchmarked scenario on this box — see the single-box caveat below before reading anything into the absolute numbers.

# green-tea Benchmarks

## Environment

- **Date**: 2026-07-07
- **Commit**: fe1831a
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
| raw-http | 115,398 | 0.00 | 1.00 | 1.00 | 0.3% | 114,822–115,539 |
| green-tea | 98,093 | 0.00 | 1.00 | 2.00 | 0.3% | 98,054–98,669 |
| nestjs-fastify | 95,034 | 1.00 | 1.00 | 2.00 | 0.5% | 94,240–95,264 |
| fastify | 86,765 | 1.00 | 2.00 | 2.00 | 0.3% | 86,496–87,123 |
| express | 24,366 | 3.00 | 5.00 | 8.00 | 0.2% | 24,283–24,418 |
| nestjs-express | 21,762 | 4.00 | 6.00 | 10.00 | 0.4% | 21,698–21,896 |

### Route param

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 116,333 | 0.00 | 1.00 | 1.00 | 0.2% | 115,974–116,410 |
| green-tea | 93,434 | 1.00 | 2.00 | 2.00 | 0.2% | 93,152–93,613 |
| nestjs-fastify | 89,312 | 1.00 | 2.00 | 2.00 | 0.1% | 89,235–89,530 |
| fastify | 86,278 | 1.00 | 2.00 | 2.00 | 0.3% | 86,138–86,765 |
| express | 23,835 | 3.00 | 5.00 | 8.00 | 0.5% | 23,803–24,046 |
| nestjs-express | 20,955 | 4.00 | 6.00 | 11.00 | 0.6% | 20,949–21,202 |

### Pipeline (3 steps) (approximation)

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 113,491 | 0.00 | 1.00 | 1.00 | 0.8% | 112,531–114,810 |
| nestjs-fastify | 87,328 | 1.00 | 2.00 | 2.00 | 0.4% | 86,867–87,661 |
| fastify | 85,024 | 1.00 | 2.00 | 2.00 | 0.3% | 84,512–85,178 |
| green-tea | 84,896 | 1.00 | 2.00 | 2.00 | 0.5% | 84,243–85,267 |
| express | 23,950 | 3.00 | 5.00 | 8.00 | 0.2% | 23,902–24,011 |
| nestjs-express | 20,824 | 4.00 | 6.00 | 11.00 | 0.1% | 20,805–20,878 |

### POST JSON + validation

| Framework | req/s (median) | p50 (ms) | p99 (ms) | p999 (ms) | CV | min–max req/s |
| --- | --- | --- | --- | --- | --- | --- |
| raw-http | 100,141 | 0.00 | 1.00 | 2.00 | 0.2% | 99,846–100,294 |
| green-tea | 77,178 | 1.00 | 2.00 | 2.00 | 0.1% | 77,126–77,254 |
| fastify | 63,722 | 1.00 | 2.00 | 3.00 | 0.1% | 63,574–63,760 |
| nestjs-fastify | 59,146 | 1.00 | 3.00 | 3.00 | 0.3% | 59,005–59,376 |
| express | 20,098 | 4.00 | 6.00 | 12.00 | 0.2% | 20,056–20,174 |
| nestjs-express | 18,856 | 5.00 | 7.00 | 30.00 | 0.5% | 18,853–19,067 |

## Step-scaling (green-tea)

| Path | Steps | req/s |
| --- | --- | --- |
| /steps/0 | 0 | 92,282 |
| /steps/3 | 3 | 81,530 |
| /steps/5 | 5 | 71,994 |

Each additional pipeline step costs roughly 4,058 req/s (-22.0% over 5 steps), on this box.

## Cost of secure-by-default (green-tea)

| Label | req/s |
| --- | --- |
| security:false (parity) | 98,093 |
| security:true (default) | 92,998 |

The real cost of running secure-by-default (rather than the parity-mode `security:false` used above) is ~5.2% req/s on this box.

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
