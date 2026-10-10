# Router parity corpus (frozen)

The compatibility baseline for replacing the linear HTTP matcher with a radix index
(FPRD-001 CARD-07/08/09/10, issue #109). Everything here was captured from
`@green-tea/core` at **`ed47836c9820c47bf4ed5e902d91e019abdb110a`** (develop after #117 and #122).

## The rule

**The baseline is immutable through CARD-07 review.** If the router change makes a test here fail,
the router changed behaviour. That is a compatibility failure, not a stale fixture.

A deliberate compatibility change needs its own maintainer approval, recorded on the card, and a
reviewed edit to the specific frozen file, in a commit that says why. Do not edit a golden to make a
test pass, do not edit `oracle.ts` to fit a new implementation, and do not delete a frozen file to
let a capture run recreate it.

Nothing can regenerate the baseline by accident:

- `vitest -u` is refused with an error. These are plain JSON files, not vitest snapshots.
- `ROUTER_PARITY_CAPTURE=1` only writes a frozen file that **does not exist**. It never
  overwrites. It is how the files were first captured, and how a new fixture gets added later.

## What is here

| File | What it freezes |
|---|---|
| `manifest.json` | Existing tests retained unchanged (ROUTER-CORPUS §1), with the verification result at the pinned revision. `manifest.test.ts` fails if a named file or test disappears. |
| `oracle.ts` | Verbatim copy of the pre-radix `matchRoute`, `resolveRoute`, `allowedMethods`, `normalizeRequestPath`, `compilePattern` and `matchWsRoute`. Test-only; `src/` must never import it. |
| `cases.ts`, `generator.ts` | Matcher inputs: 24 hand-picked scenarios (§2), 9 owner-requested scenarios (backtracking, cross-pattern `Allow`, encoded slashes, zero-segment catch-alls), and a fixed-seed generator in two versions, both seed `10908`: `router-parity-gen-v1`, and `router-parity-gen-v2`, which forces static/param/constrained/catch-all siblings under shared prefixes. |
| `branches.ts` | Measures the share of generated requests that walk into sibling branches and backtrack; frozen with the v2 fixture. |
| `frozen/matcher-*.json` | Captured matcher outputs: declaration ID, decoded params, `implicitHead`, ordered `Allow`, or the normalization error. The generated file also stores the seed, the generator rules and every generated input. |
| `frozen/app-*.json` | Status, headers, `Allow` and body through `app.fetch` and through a Node socket, including HEAD body suppression. |
| `frozen/ws-*.json` | WS upgrade selection through `app.upgrade` and the Node listener, plus HTTP requests at the WS paths. |
| `frozen/owner-*.json` | Owner additions needing a running app: cross-pattern `Allow` through both adapters, and the mesh HTTP route table across a peer's lifetime (it is built once at boot and never changes — see `owner.test.ts`). |
| `frozen/boot-*.json` | Boot-time rejections: pattern compilation, local ambiguity, mesh splicing. |
| `frozen/golden-*.json` | `graph()`, `explain()`, `openapi({ title: 'Parity', version: '1' })`, and a mesh teacup before and after `ready()`. |

## How the comparison works

`matcher.test.ts` runs every scenario through the oracle **and** through the live
`src/http/router` exports, and requires both to equal the frozen capture. Today the live router is
the linear matcher, so this proves the oracle is a faithful copy. CARD-07 replaces the internals
behind the same exports, and the same test then compares oracle against radix with no edit here.

Each run builds fresh `RouteDef` objects, so the two implementations never share a cached table, and
the answering route is identified by declaration ID, never by pattern text.

Application-level, WS, boot and introspection files are compared against the live code only,
because there is no second implementation of `app.fetch` to diff against; the frozen capture plays
the oracle's role.

The performance half of the baseline is in `bench/lookup.ts` and `bench/baseline/router-ed47836/`.
