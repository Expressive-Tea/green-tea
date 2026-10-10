# Pre-radix router baseline — `ed47836`

The performance half of the CARD-08 parity corpus (FPRD-001, #109), captured before any CARD-07
router change and immutable through CARD-07 review, like `test/router-parity/`. CARD-10 measures
the radix index with the **same harness and defaults, on the same host, cpuset and image**, running
`LOOKUP_ROUTERS="base=<ed47836 router>,head=src/http/router.ts"`. Do not re-run into this directory:
a new capture goes in a new directory.

## Files

| File | What it is |
|---|---|
| `lookup-raw.json` | **The D4 baseline.** Interleaved `bench:lookup` with the live linear matcher as A and the byte-identical frozen oracle as B: environment, method, every sample of every round, and the summary. The live column gives the absolute baseline; the B/A ratios give the A/A noise floor. |
| `lookup-summary.txt` | The tables that run printed. |
| `load.txt` | `uptime` and running CI job containers, before and after. |
| `battery-run/` | The superseded first capture (laptop on battery, sequential harness), kept for reference, including its `bench:compare` end-to-end req/s run. |

## Environment

| | |
|---|---|
| Host | jarvis (homelab), Ubuntu 24.04.3 LTS, kernel 6.8.0-138-generic, x86_64 |
| CPU | AMD Ryzen 7 3700X, 8 cores / 16 threads, 2 × 16 MiB L3, governor `schedutil` (host default; not changed) |
| Memory | 62.7 GiB |
| Isolation | `docker run --rm --cpuset-cpus 6,7,14,15`: physical cores 6 and 7 plus their SMT siblings, both on the second CCX. All 16 CPUs were 0.0–0.8% busy in a 5 s sample beforehand. |
| Container | `node:22` (`sha256:5647be70…`), Node v22.23.1, V8 12.4.254.21-node.56; Docker 29.1.3 |
| Power | Not applicable (mains-powered server) |
| Load | 1-minute load 0.27 before, 0.79 after; no CI job containers running (see `load.txt`). jarvis also runs long-lived services (payments-automation, open-webui, windmill, the Gitea act_runner, alloy, beszel), none of them pinned off these cores. |
| Revision | Router at `ed47836c9820c47bf4ed5e902d91e019abdb110a`; harness `ee7fdec`, whose `src/` is byte-identical to `ed47836`. Copied with `git archive`, `npm ci --ignore-scripts` in the container. |
| Env vars | Only `LOOKUP_*` (recorded in `meta.env`); no `NODE_OPTIONS`. |

## Method (`bench/lookup.ts` at `ee7fdec`, defaults)

- **Operation:** `resolveRoute(routes, method, path)`, and on `undefined`, `allowedMethods(routes, path)` — what `dispatch` does after `normalizeRequestPath`.
- **Route counts:** 10, 100 and 500 **total registered HTTP routes**, from the recorded generator (`meta.method.routeGenerator`).
- **Workloads:** static hit, late parameter hit, method miss, path miss; each answer is asserted before timing.
- **Interleaving:** for each cell, every router is warmed for 250 ms (also calibrating ≈25 ms samples), then 21 rounds of one sample per router with the order alternating AB / BA.
- **Repetitions:** 4 fresh processes, with module import order alternating per process → 84 paired rounds per cell. Every sample is kept.
- **Statistics:** absolute = median ns per lookup over all 84 samples; ratio = median of the 84 per-round B/A ratios, with a percentile-bootstrap 95% CI (4000 resamples, seed 10908).

## Baseline: live linear matcher (median ns per lookup)

| Routes | Workload | live median ns | run medians (ns) | run spread |
|---:|---|---:|---|---:|
| 10 | static hit | 185.3 | 156.1 / 187.7 / 174.1 / 194.2 | 20.5% |
| 10 | late param hit | 328.4 | 311.9 / 336.2 / 323.0 / 342.4 | 9.3% |
| 10 | method miss | 800.4 | 762.6 / 801.2 / 798.6 / 804.4 | 5.2% |
| 10 | path miss | 625.5 | 594.6 / 631.3 / 620.3 / 628.1 | 5.9% |
| 100 | static hit | 201.2 | 202.2 / 200.8 / 197.6 / 207.2 | 4.8% |
| 100 | late param hit | 878.0 | 861.1 / 857.0 / 907.3 / 880.5 | 5.7% |
| 100 | method miss | 2,525 | 2,424 / 2,514 / 2,580 / 2,531 | 6.2% |
| 100 | path miss | 3,054 | 2,965 / 3,024 / 3,114 / 3,071 | 4.9% |
| 500 | static hit | 202.2 | 201.8 / 202.3 / 195.1 / 210.3 | 7.5% |
| 500 | late param hit | 2,931 | 2,830 / 2,804 / 2,980 / 3,016 | 7.2% |
| 500 | method miss | 11,904 | 11,635 / 11,518 / 11,946 / 12,031 | 4.3% |
| 500 | path miss | 15,514 | 15,103 / 14,972 / 15,665 / 16,034 | 6.8% |

## A/A noise floor: identical code, oracle / live

| Routes | Workload | oracle / live median | 95% CI |
|---:|---|---:|---|
| 10 | static hit | 0.9507 (-4.9%) | -13.7% … +11.9% |
| 10 | late param hit | 1.0415 (+4.1%) | -1.6% … +9.8% |
| 10 | method miss | 0.9809 (-1.9%) | -4.4% … +0.8% |
| 10 | path miss | 0.9919 (-0.8%) | -3.2% … +1.4% |
| 100 | static hit | 1.0082 (+0.8%) | -1.9% … +4.5% |
| 100 | late param hit | 1.0247 (+2.5%) | +1.9% … +2.9% |
| 100 | method miss | 1.0055 (+0.6%) | +0.3% … +0.7% |
| 100 | path miss | 1.0165 (+1.7%) | +1.2% … +1.9% |
| 500 | static hit | 1.0107 (+1.1%) | -2.2% … +4.5% |
| 500 | late param hit | 0.9838 (-1.6%) | -2.2% … +0.8% |
| 500 | method miss | 1.0197 (+2.0%) | +1.6% … +2.3% |
| 500 | path miss | 1.0161 (+1.6%) | +0.5% … +2.6% |

**For D4:**

- **Import order.** In-process, the module imported first is faster on the cheapest cell. At 10-route static hit (≈180 ns) the per-run medians swap by about 20% when the import order swaps (run 1: live 156, oracle 200 ns; run 2: live 188, oracle 162 ns). Alternating the import order removes that bias from the median, but it leaves that cell's 95% CI at −13.7 … +11.9%. A ≤5% regression limit cannot be resolved there with this method and sample size.
- **Other 10-route cells.** The CIs are within about ±10% (late parameter hit −1.6 … +9.8%), and the misses are within ±4.4%.
- **100 and 500 routes.** Identical code shows small but systematic offsets of up to +2.9%, with CIs that exclude 1. Treat anything inside ±3% as indistinguishable from no change.
- **500 routes.** The ≥20% improvement target is far outside the noise in every cell.

The options for D4 are to apply the 10-route limit to the miss and late-parameter cells only, to require more rounds for the static cell, or to restate the limit relative to this measured floor. That decision belongs to the owner.
