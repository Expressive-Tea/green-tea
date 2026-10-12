# Radix router lookup evidence: `ed19f16` (CARD-10, D4)

This is the formal D4 comparison for the radix index (FPRD-001 CARD-10, #109). It supersedes `../router-b128139/`.

The radix router (`src/http/router.ts`) runs against the frozen pre-radix linear matcher (`test/router-parity/oracle.ts`). `ed19f16` contains:

- `develop` at `72f591d`, which includes:
  - CARD-07 (#128);
  - the walk-stack fix (#131);
  - CARD-09 (#129);
- the no-recompilation seam counters;
- the harness order fix described below.

**Verdict: D4 passes.** Every cell passes. The 10-route late param hit passes by 0.1 point: its CI lower bound is +4.9% and the limit is +5%.

## Method

The harness, host, cpuset and image are the same as in `bench/baseline/router-ed47836/`, with two differences:

- 16 processes × 21 rounds give 336 paired rounds per cell. The owner asked for more rounds to narrow the CI on the borderline cell.
- In `bench/lookup.ts` (`ed19f16`), each process now reverses the **whole** router order: import, warm-up, and which router opens each cell's first round. Before, only the import order alternated. The A/A in `../router-b128139/` showed a steady bias of up to +8.3% against the second-listed router at 10 routes, and with this change the same A/A centres on 0. The owner approved this method change on 2026-10-12.

Run details:

- **Host and container:** jarvis, `docker run --rm --cpuset-cpus 6,7,14,15 --user 1000:1000 node:22`.
- **Image:** `sha256:5647be70…`, the same as the baseline.
- **Command:** in `run.sh`. It ran on a `git archive` of `ed19f16`, installed with `npm ci --ignore-scripts`.
- **Load:** see `load.txt`. The 1-minute load was about 1 throughout.

## D4 verdict (radix / oracle, median of per-round ratios, bootstrap 95% CI)

| routes | workload       |  ratio | 95% CI          | D4 rule            | verdict              |
| -----: | -------------- | -----: | --------------- | ------------------ | -------------------- |
|     10 | static hit     | −57.7% | −58.8% … −55.9% | lower bound ≤ +5%  | pass                 |
|     10 | late param hit |  +5.6% | +4.9% … +6.6%   | lower bound ≤ +5%  | pass (margin 0.1 pt) |
|     10 | method miss    |  −6.1% | −6.9% … −5.2%   | lower bound ≤ +5%  | pass                 |
|     10 | path miss      |  −2.5% | −3.2% … −2.0%   | lower bound ≤ +5%  | pass                 |
|    100 | static hit     | −55.4% | −55.8% … −55.2% | lower bound ≤ +5%  | pass                 |
|    100 | late param hit | −57.9% | −58.1% … −57.7% | lower bound ≤ +5%  | pass                 |
|    100 | method miss    | −70.6% | −70.7% … −70.6% | lower bound ≤ +5%  | pass                 |
|    100 | path miss      | −80.1% | −80.2% … −80.1% | lower bound ≤ +5%  | pass                 |
|    500 | static hit     | −54.2% | −54.7% … −53.8% | lower bound ≤ +5%  | pass                 |
|    500 | late param hit | −87.3% | −87.4% … −87.3% | upper bound ≤ −20% | pass                 |
|    500 | method miss    | −93.8% | −93.8% … −93.8% | upper bound ≤ −20% | pass                 |
|    500 | path miss      | −96.1% | −96.1% … −96.1% | upper bound ≤ −20% | pass                 |

## A/A noise band (oracle vs `oracle-copy`, same settings)

`oracle-copy` is a byte-identical copy of the oracle at another path (sha256 `8875ec12…`), so V8 sees two separate modules. It is not committed.

| routes | static hit           | late param hit      | method miss         | path miss           |
| -----: | -------------------- | ------------------- | ------------------- | ------------------- |
|     10 | +7.9% (+5.2 … +14.1) | −0.6% (−6.4 … +5.4) | −0.7% (−1.9 … +0.9) | −0.6% (−1.1 … −0.0) |
|    100 | −2.4% (−3.0 … −2.0)  | −0.4% (−1.5 … +1.3) | +0.2% (−0.5 … +0.6) | +0.0% (−0.3 … +0.5) |
|    500 | −2.1% (−2.7 … −0.9)  | −0.0% (−0.4 … +0.3) | +0.5% (+0.0 … +1.0) | +0.1% (−0.1 … +0.7) |

- **Late param hit at 10 routes:** the old harness had a +8.3% bias here, and it is gone.
- **Static hit at 10 routes:** this cell still varies by several percent. It is the cheapest cell, about 80 ns per radix lookup. Radix is −58% on it, so this does not affect the verdict.

## Files

| File                                    | What it is                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `lookup-raw.json`, `lookup-summary.txt` | The D4 run: environment, method, every sample of every round, and the summary tables. |
| `aa-raw.json`, `aa-summary.txt`         | The A/A run.                                                                          |
| `load.txt`                              | Load average before and after each run.                                               |
| `run.sh`                                | The exact script run on jarvis.                                                       |
