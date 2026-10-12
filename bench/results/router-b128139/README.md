# Radix router lookup evidence — `b128139` (CARD-10, D4)

The formal D4 comparison for the radix index (FPRD-001 CARD-10, #109): the radix router at
`b128139` against the frozen pre-radix linear matcher, with the harness, host, cpuset and image of
the baseline in `bench/baseline/router-ed47836/`. `b128139` is `develop` at `cb123e3` (CARD-07,
PR #128) plus the internal seam counters added for the no-recompilation test; the attribution run
below shows those counters do not move the numbers.

**Verdict: D4 fails at 10 routes** (late param hit, method miss, path miss). 100 and 500 routes pass.
The cause is localized below to one CARD-07 commit. Per the card, no threshold was relaxed and no
`src/` change was made to recover it; this is evidence for an owner decision.

## Files

| File | What it is |
|---|---|
| `lookup-raw.json` | **The D4 run.** A = `oracle` (`test/router-parity/oracle.ts`, the pre-radix linear matcher), B = `radix` (`src/http/router.ts` at `b128139`). Environment, method, every sample of every round, and the summary. |
| `lookup-summary.txt` | The tables that run printed. |
| `aa-raw.json`, `aa-summary.txt` | A/A noise band, same settings: `oracle` against `oracle-copy`, a byte-identical copy of the oracle at another path (sha256 `8875ec12…`, same as the original), so V8 sees two separate modules. |
| `attrib-raw.json`, `attrib-summary.txt` | Diagnostic only, not part of the D4 verdict: oracle against the radix router at `5e0ae94`, `cb123e3` and `b128139` in the same process. |
| `load.txt` | `uptime` and running CI job containers before and after each run. |

## Environment

| | |
|---|---|
| Host | jarvis (homelab), Ubuntu 24.04, kernel 6.8.0-138-generic, x86_64, AMD Ryzen 7 3700X, 62.7 GiB — same host as the baseline |
| Isolation | `docker run --rm --cpuset-cpus 6,7,14,15 --user 1000:1000` (cpuset reported inside the container: `6-7,14-15`) |
| Container | `node:22`, image id `sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37` — the baseline's image; Node v22.23.1, V8 12.4.254.21-node.56; Docker 29.1.3 |
| Revision | `b128139e2f4447af52b6b6d1a0d60d92664e40f8`, copied with `git archive`; `npm ci --ignore-scripts` inside the container |
| Load (1/5/15 min) | D4 run: 0.24 0.25 0.11 before, 1.92 1.40 0.66 after. A/A: 1.92 1.40 0.66 before, 1.62 1.50 0.92 after. No CI job containers at any point. The rise is the benchmark itself (16 consecutive processes) plus jarvis's long-lived services; see `load.txt`. |
| Env vars | Only `LOOKUP_*` (recorded in `meta.env`); no `NODE_OPTIONS` |

## Method

`bench/lookup.ts` unchanged from the baseline (defaults: 250 ms warm-up per router per cell, ≈25 ms
samples, rounds alternating AB/BA, import order alternating per process, bootstrap 95% CI of the
median paired ratio, 4000 resamples, seed 10908). The one difference is more repetitions, as the
owner asked, to narrow the CIs: **16 fresh processes × 21 rounds = 336 paired rounds per cell**
(baseline: 4 × 21 = 84).

```sh
docker run --rm --cpuset-cpus 6,7,14,15 --user 1000:1000 -e HOME=/tmp -v "$PWD":/w -w /w \
  -e LOOKUP_ROUTERS="oracle=test/router-parity/oracle.ts,radix=src/http/router.ts" \
  -e LOOKUP_RUNS=16 -e LOOKUP_ROUNDS=21 -e LOOKUP_OUT=out/lookup-raw.json \
  -e LOOKUP_COMMIT=b128139e2f4447af52b6b6d1a0d60d92664e40f8 -e LOOKUP_HOST=jarvis -e LOOKUP_CPUSET=6,7,14,15 \
  -e LOOKUP_DOCKER="$(docker --version)" -e LOOKUP_KERNEL="$(uname -r)" \
  -e LOOKUP_IMAGE="$(docker image inspect node:22 --format '{{.Id}}')" \
  node:22 node --import tsx bench/lookup.ts
```

The A/A run is the same command with `LOOKUP_ROUTERS="oracle=test/router-parity/oracle.ts,oracle-copy=aa/oracle-copy.ts"`
and `LOOKUP_OUT=out/aa-raw.json`, started immediately after.

## D4 rule (accepted by the owner, 2026-10-10)

Per cell, B/A = median lookup time ratio radix / oracle with its bootstrap 95% CI.

- No regression anywhere: a cell **fails** only if its CI **lower** bound is above +5%.
- At 500 routes, late param hit, method miss and path miss must also have a CI **upper** bound ≤ −20%. Static hit at 500: no regression only.

## D4 verdict — radix / oracle, 336 paired rounds per cell

| Routes | Workload | oracle ns | radix ns | radix / oracle | 95% CI | Rule | Verdict |
|---:|---|---:|---:|---:|---|---|---|
| 10 | static hit | 189.3 | 79.9 | 0.4198 (−58.0%) | −59.5% … −56.5% | lower ≤ +5% | PASS |
| 10 | late param hit | 335.8 | 495.8 | 1.5253 (+52.5%) | +51.6% … +53.0% | lower ≤ +5% | **FAIL** |
| 10 | method miss | 774.2 | 1,032.5 | 1.3181 (+31.8%) | +31.3% … +32.3% | lower ≤ +5% | **FAIL** |
| 10 | path miss | 605.2 | 1,216.1 | 2.0192 (+101.9%) | +100.6% … +102.9% | lower ≤ +5% | **FAIL** |
| 100 | static hit | 203.1 | 94.4 | 0.4632 (−53.7%) | −53.9% … −53.4% | lower ≤ +5% | PASS |
| 100 | late param hit | 880.6 | 499.1 | 0.5726 (−42.7%) | −42.9% … −42.6% | lower ≤ +5% | PASS |
| 100 | method miss | 2,515.1 | 1,048.2 | 0.4193 (−58.1%) | −58.3% … −57.8% | lower ≤ +5% | PASS |
| 100 | path miss | 3,042.8 | 1,218.2 | 0.4042 (−59.6%) | −59.9% … −59.4% | lower ≤ +5% | PASS |
| 500 | static hit | 203.9 | 96.3 | 0.4673 (−53.3%) | −53.5% … −53.2% | lower ≤ +5% | PASS |
| 500 | late param hit | 2,825.2 | 498.6 | 0.1751 (−82.5%) | −82.6% … −82.4% | upper ≤ −20% | PASS |
| 500 | method miss | 11,838.0 | 1,052.0 | 0.0887 (−91.1%) | −91.2% … −91.1% | upper ≤ −20% | PASS |
| 500 | path miss | 15,335.4 | 1,218.9 | 0.0786 (−92.1%) | −92.2% … −92.1% | upper ≤ −20% | PASS |

The oracle's absolute medians match the baseline's live linear matcher within a few percent in every
cell (e.g. 10-route late param 335.8 vs 328.4 ns, 500-route path miss 15,335 vs 15,514 ns), so the
host and setup are comparable with the baseline capture.

## A/A noise band — oracle-copy / oracle, same settings

| Routes | Workload | ratio | 95% CI |
|---:|---|---:|---|
| 10 | static hit | 1.0421 (+4.2%) | +2.1% … +5.7% |
| 10 | late param hit | 1.0829 (+8.3%) | +7.1% … +9.1% |
| 10 | method miss | 0.9862 (−1.4%) | −2.0% … +0.2% |
| 10 | path miss | 0.9988 (−0.1%) | −0.7% … +0.1% |
| 100 | static hit | 1.0384 (+3.8%) | +2.4% … +5.4% |
| 100 | late param hit | 1.0285 (+2.9%) | +2.6% … +3.0% |
| 100 | method miss | 0.9971 (−0.3%) | −0.5% … −0.0% |
| 100 | path miss | 1.0100 (+1.0%) | +0.7% … +1.2% |
| 500 | static hit | 1.0374 (+3.7%) | +2.7% … +4.9% |
| 500 | late param hit | 1.0113 (+1.1%) | +0.9% … +1.4% |
| 500 | method miss | 1.0107 (+1.1%) | +0.8% … +1.3% |
| 500 | path miss | 1.0155 (+1.5%) | +1.3% … +1.9% |

With 336 rounds the CIs are narrow, so identical code now shows **systematic** offsets that exclude
1: up to +8.3% (CI +7.1 … +9.1%) at 10-route late param hit, and +3.7 … +4.2% on the static hits.
The baseline's A/A had the same sign at that cell (+4.1%, CI −1.6 … +9.8%). The harness therefore
carries an in-process bias of up to ≈9% against the second-listed router on the cheapest cells,
which the 5% rule does not account for. It does not change this verdict: the three failing cells
are 30–100% slower, far outside the band.

## Attribution (diagnostic, not part of the verdict)

Same image, cpuset and harness, 8 processes × 21 rounds, four routers in one process. The two
older revisions are `git show <sha>:src/http/router.ts` (sha256 checked against git).

| 10 routes | `5e0ae94` (before the last CARD-07 fix) | `cb123e3` (merged CARD-07) | `b128139` (this commit) |
|---|---|---|---|
| late param hit | +5.3% (+4.1 … +9.4%) | +44.9% (+42.9 … +52.6%) | +45.5% (+44.1 … +51.2%) |
| method miss | −2.6% (−2.8 … −2.1%) | +34.4% (+33.9 … +35.2%) | +34.4% (+33.3 … +35.1%) |
| path miss | +1.2% (+1.0 … +1.4%) | +105.9% (+104.7 … +106.3%) | +103.4% (+102.5 … +103.9%) |

- The regression arrived with `a2b71e2` (*fix(router): drop pending walk frames when a segment
  fails to decode*), the only router change between `5e0ae94` and `cb123e3`. It wraps the walk
  loop in `try … finally` and resets `stackNodes.length` / `stackDepths.length` on every walk.
  It costs a roughly constant 130–650 ns per lookup, depending on how many walks a lookup makes,
  at every route count. Static hits, which take the `exactPaths` shortcut and never walk, are unaffected.
- `b128139` matches `cb123e3` within noise in every cell, so the seam counters added by this change
  do not affect lookup time.
- At `5e0ae94`, the 10-route cells were within D4 (late param lower bound +4.1%) and the 100- and
  500-route improvements were larger (e.g. 500-route path miss −95.9% vs −91.8% now).

No optimization was attempted here; restoring the walk's cost without losing the `a2b71e2` fix is a
`src/` change for the owner to decide on.
