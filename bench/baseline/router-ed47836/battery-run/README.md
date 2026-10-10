# Superseded: first baseline, laptop on battery — `ed47836`

> Kept for reference only. **The baseline is `../README.md`**, captured on jarvis with the
> interleaved harness. This run used the earlier sequential harness (`98ea948`), one router per
> process, on a laptop running on battery.

The performance half of the CARD-08 parity corpus (FPRD-001, #109). Captured before any CARD-07
router change; immutable through CARD-07 review, like `test/router-parity/`. CARD-10 measures the
radix index with the **same harness, same defaults, same machine class**, and compares against
these files. Do not re-run into this directory: a new capture goes in a new directory.

## Files

| File | What it is |
|---|---|
| `lookup-raw.json` | **The D4 baseline.** `bench:lookup` on the live linear matcher: environment, method, every sample of every run, and the summary. |
| `lookup-summary.txt` | The table `bench:lookup` printed for that run. |
| `lookup-aa-raw.json`, `lookup-aa-summary.txt` | A/A noise check: the live router against the byte-identical frozen oracle (`test/router-parity/oracle.ts`), same alternating protocol. Any difference here is noise. |
| `compare-e2e-raw.json`, `compare-e2e-summary.txt`, `compare-e2e-stderr.txt` | `npm run bench:compare`, run once with this tree as both base and head. **End-to-end req/s signal only**: 50/200 *filler* routes plus base routes, not 10/100/500 total, and not lookup time. It cannot decide D4. |
| `load.txt` | `uptime` before and after each run. |

## Environment

| | |
|---|---|
| Hardware | Apple M4 Max (`Mac16,5`), 16 cores (12 performance + 4 efficiency), 64 GiB |
| Power | **On battery** (84%, discharging) for every run. macOS may manage clocks differently on AC; run the CARD-10 comparison on the same power source, or re-capture both on AC. |
| OS | macOS 27.0.1 (build 26A434), Darwin 27.0.0 arm64 |
| Node | v22.22.2 (V8 12.4.254.21-node.39) |
| Packages | `@green-tea/core@26.9.0-beta.2`; tsx 4.23.5, typescript 5.9.3, vitest 4.1.11, autocannon 8.0.0 (from `package-lock.json`) |
| Core revision | Router source at `ed47836c9820c47bf4ed5e902d91e019abdb110a`. The harness ran from `98ea948` (this branch), whose `src/` is byte-identical to `ed47836` — the branch adds only tests and bench files. |
| Env vars | `LOOKUP_OUT` only (and `LOOKUP_ROUTERS` for the A/A run); no `NODE_OPTIONS`. Recorded in each raw file under `meta.env`. |
| Load | 1-minute load average 2.4–3.4 on 16 cores throughout (see `load.txt` and `meta.loadavgAtStart/End`). Foreground apps were a browser and the window server; nothing else CPU-bound. |

## Method (`bench/lookup.ts`, defaults)

- **Operation:** `resolveRoute(routes, method, path)`, and on `undefined`, `allowedMethods(routes, path)` — what `dispatch` does after `normalizeRequestPath`. Normalization is excluded.
- **Route counts:** 10, 100 and 500 **total registered HTTP routes**.
- **Generator:** N−2 fillers cycling `GET /res{k}/items`, `POST /res{k}/items`, `GET /res{k}/items/:id`, `PUT /res{k}/items/:id(\d+)`, `GET /res{k}/files/:path*` (k = ⌊i/5⌋), then `GET /static/target/leaf`, then `GET /late/:group/:id` declared last.
- **Workloads:** static hit `GET /static/target/leaf`; late parameter hit `GET /late/g1/42`; method miss `DELETE /static/target/leaf` (Allow `GET, HEAD, OPTIONS`); path miss `GET /nowhere/at/all`. Each answer is asserted before timing.
- **Order:** for each run, for each router (order alternates per run), for count 10 → 100 → 500, for the four workloads in the order above.
- **Warm-up:** 250 ms per cell, time-boxed; it also calibrates iterations so one sample lasts ≈25 ms (iteration counts are stored per cell).
- **Repetitions:** 5 runs, each a fresh child process; 21 samples per cell per run → 105 samples per cell. Every sample is kept.
- **Statistic:** median ns per lookup over all 105 samples. Run spread = (max − min of the five per-run medians) / median.

## Baseline (median ns per lookup, `lookup-raw.json`)

| Routes | Static hit | Late param hit | Method miss | Path miss |
|---:|---:|---:|---:|---:|
| 10 | 61.3 (spread 17.5%) | 123.3 (6.2%) | 313.1 (4.6%) | 247.1 (6.8%) |
| 100 | 67.6 (8.0%) | 343.4 (2.1%) | 1 263.7 (3.5%) | 1 463.3 (3.2%) |
| 500 | 67.8 (7.5%) | 1 326.8 (16.5%) | 6 732.2 (6.5%) | 8 973.4 (2.0%) |

## Noise floor (A/A, `lookup-aa-raw.json`)

Identical matcher code under two labels, alternating order per run. Median difference
(oracle − live) / live:

| Routes | Static hit | Late param hit | Method miss | Path miss |
|---:|---:|---:|---:|---:|
| 10 | +5.2% | 0.0% | +1.2% | +0.2% |
| 100 | −0.1% | −0.8% | −0.1% | +0.1% |
| 500 | −2.7% | +0.3% | −0.4% | +0.1% |

**For D4:** with no code difference at all, the 10-route static hit already moves 5.2% — the
size of the proposed ≤5% regression limit — and per-run medians at 10 routes spread 4.5–17.5%.
That cell is ~60 ns, where a few nanoseconds of timer and scheduling noise are a large fraction.
The ≥20% improvement at 500 routes is well clear of the noise (≤2.7% A/A, ≤16.5% spread on a
1.3–9 µs operation). Whether D4's 10-route limit applies per workload, to a mean across workloads,
or needs more runs is an owner decision; this baseline does not make it.

## End-to-end signal (`bench:compare`, req/s — not lookup time)

Run once, A/A: `AB_BASE` pointed at this same tree, so base and head are identical code. Defaults:
3 rounds × 10 s per case after a 10 s warm-up, 100 connections, alternating side order. Load
average 2.8–3.3 throughout. A few short parity-test runs (seconds each) happened during this
~22-minute run; the lookup runs above had nothing else running.

| Scenario | base req/s | head req/s | Δ |
|---|---:|---:|---:|
| hello | 88,212 | 88,236 | +0.0% |
| param | 86,508 | 85,885 | −0.7% |
| pipeline (3 steps) | 80,189 | 80,934 | +0.9% |
| steps5 | 74,359 | 73,975 | −0.5% |
| validate (POST) | 70,607 | 69,903 | −1.0% |
| hello + security | 83,913 | 83,802 | −0.1% |
| hello + cors predicate | 82,028 | 80,445 | −1.9% |
| preflight + cors predicate | 114,377 | 114,010 | −0.3% |
| param, 50 routes | 82,476 | 82,045 | −0.5% |
| param, 200 routes | 72,957 | 73,306 | +0.5% |

Every row's sample ranges overlap. So with no code change, end-to-end throughput moves up to
±1.9%; the route-width rows show that 200 filler routes already cost ~12% req/s against
`param` with none.
