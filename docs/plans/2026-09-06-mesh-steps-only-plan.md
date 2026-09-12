# A mesh that exports steps, not providers

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to work through this task by task. Steps use `- [ ]` for tracking.

**Status:** planned, 2026-09-06
**Scope:** `src/mesh/protocol.ts`, `src/mesh/teapot.ts`, `src/mesh/teacup.ts`, `src/app/index.ts`,
mesh tests on all runtimes, `README.md`, `CHANGELOG.md`
**Mesh stays alpha.** It remains behind `experimental: true`, and the wire changes without a
protocol bump because of it.

**Goal:** A teapot exports **steps and routes only**. Exporting a `@Provider` becomes a boot error,
and a teapot that is unreachable at boot no longer stops the teacup from starting.

## The problem

`@Provider` is a factory whose value *is* the object — `db`, a client, a pool. That object cannot
cross a wire, and the mesh already knows it: `untransportable` (`src/mesh/protocol.ts:145`) refuses
any class instance, so an exported provider can only ever return plain data. What survives is the
worst half of the idea — `src/app/index.ts:854` registers the remote provider as an **app-scope**
binding, so the teacup resolves it once at boot and answers from that snapshot for the life of the
process. It is a cache the teapot no longer stands behind, wearing the word "provider".

A step is the shape that actually works across the mesh. It runs per request, the teacup sends the
envelope, the teapot resolves its own graph and sends back the result, and the teacup binds it to
the token. Transparent to the caller, and nothing is held.

Two things follow from that, and they are the whole of this plan:

1. **Exporting a provider is not a feature to fix, it is a thing to forbid.** The alternative
   already exists and is spelled `@Step({ export: true })`.
2. **The boot no longer needs to block on a teapot.** Blocking existed because an app-scope value
   has to be resolved *at boot* — there is no later. A step has nothing but later. A teapot that is
   away costs a `503` on the requests that need it, and the app starts.

## Decisions

**D1 — `export: true` on a `@Provider` is a boot error, not a silent no-op.** Turning it into a
warning would leave a running app whose token resolves locally and looks exported. The error names
the replacement, so the message is a fix and not a complaint.

**D2 — No protocol bump.** Removing `ScopeEntry.scope` is a field removal, which the rule in
`src/mesh/protocol.ts:11` would normally make a bump. Mesh is alpha and behind `experimental: true`,
both peers ship from this repo, and a bump would spend the number on a version nobody deployed.
`MESH_PROTOCOL_VERSION` stays `1`.

**D3 — Keep `connectUntilDeadline`; delete only its `throw`.** *This corrects what was said in the
design conversation.* The retry loop is not the boot blocker — the `throw` at the end of it is. The
loop is the co-deploy grace: a teacup that starts two seconds ahead of its teapot waits, gets the
manifest, and has its steps for the process lifetime. Delete the loop and that teacup instead boots
into a graph with no `authorization` node, which is strictly worse than today. So the budget stays;
exhausting it now warns and contributes nothing, instead of failing the boot.

**D4 — A permanent refusal still fails the boot.** `isPermanentRefusal` covers a wrong secret and a
protocol mismatch. Those are configuration errors — the same class as a typo in a token name — and
they will be the same errors in thirty seconds. Failing at boot with the reason beats a `503` at
3am that says nothing about a secret. Only *unreachable* becomes non-fatal.

**D5 — A missing token still fails the boot, through the ordinary validator.** If a teapot is away
and a local step declares `needs: ['authorization']`, `topoSort` throws
`missing dependency: authorization needed by …` (`src/graph.ts:54`). That is not a mesh step to
remove: it is what catches a typo, and tolerating it would let a misspelled token boot clean and
`503` forever. The message gains the teapots that did not connect, so the cause is on the screen.

**D6 — The `expects` / degrade plan survives; its D6 does not.**
`docs/plans/2026-08-18-mesh-degrade-plan.md` is still the right answer for "this teapot may
legitimately be absent", and it is already steps-only. But its D6 reuses
`invalidateRemoteBindings`, which this plan deletes. That seam was app-scope-specific; a degraded
step swaps a runner, not a container binding. Note it there rather than leave a dangling reference.

## File structure

| File | Change |
| --- | --- |
| `src/mesh/protocol.ts` | `Manifest` → `{ steps: string[]; routes: RouteEntry[] }`; drop `ScopeEntry`; update the `manifest` frame and its `SHAPE` row |
| `src/mesh/teapot.ts` | `buildManifest({ steps, routes })` |
| `src/mesh/teacup.ts` | `buildRemote` → `{ steps, routes }` |
| `src/graph.ts` | `topoSort` takes an optional note appended to the missing-dependency error |
| `src/app/index.ts` | forbid provider export; drop the remote-provider loop, `rebind`, `invalidateRemoteBindings`, `exportedProviders`; `connectUntilDeadline` exhaustion becomes non-fatal |
| tests | `test/mesh/*`, `test/deno/mesh*`, `test/bun/mesh*`, `test/interop/_node-peer.ts`, `test/edge/_worker.mjs` |
| docs | `README.md` mesh section, `CHANGELOG.md`, the degrade plan's D6 |

## A note on the line numbers

Every `file:line` below is accurate as of `85b6c70` and drifts as tasks land. Locate code by symbol —
`collectProviders`, `spliceRemoteScopes`, `connectUntilDeadline`, `buildMeshControl`, `finalizeGraph`
— and treat the numbers as hints.

---

## Task 1: Forbid exporting a provider

The prohibition lands first and alone, because every later task assumes it. Nothing on the wire
changes yet.

**Files**
- Modify: `src/app/index.ts:440` (`collectProviders`)
- Test: `test/mesh/failure.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/mesh/failure.test.ts
import { describe, it, expect } from 'vitest';
import { createApp, Provider, Module } from '../../src/index';

describe('provider export', () => {
  it('refuses to boot when a provider is exported over the mesh', async () => {
    @Provider({ provides: 'db', needs: [], export: true } as any)
    class Db {
      provide() {
        return { db: { query: () => [] } };
      }
    }
    @Module({ mountpoint: '/api', providers: [Db] })
    class AppModule {}

    expect(() => createApp({ modules: [AppModule], mesh: { secret: 's' } })).toThrow(
      /provider 'db' cannot be exported/i,
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run test/mesh/failure.test.ts -t 'refuses to boot'
```

Expected: FAIL — no error is thrown, the app builds.

- [ ] **Step 3: Throw in `collectProviders`**

Replace `src/app/index.ts:440`:

```ts
    if (meta.export) registry.exportedProviders.push(meta.provides);
```

with:

```ts
    // A provider's value IS the object it builds — a pool, a client, a `db`. That cannot cross a
    // wire, and the half of it that could (plain data) arrived as an app-scope binding the teacup
    // resolved once and cached for the life of the process. A step is the shape that travels:
    // it runs per request, on the teapot, and only its result comes back.
    if (meta.export)
      throw new Error(
        `mesh: provider '${meta.provides}' cannot be exported — a provider is a factory whose value ` +
          'is the object itself, and the mesh transports data, not objects. ' +
          'Export a @Step instead, which runs on the teapot per request and returns its result.',
      );
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run test/mesh/failure.test.ts -t 'refuses to boot'
```

Expected: PASS.

- [ ] **Step 5: Fix every test that exported a provider**

```bash
npx vitest run test/mesh/
```

Convert any `@Provider({ ..., export: true })` in a fixture to `@Step({ ..., export: true })`.
Check `test/mesh/integration.test.ts`, `test/mesh/envelope.test.ts`, `test/mesh/transport.test.ts`,
`test/mesh/fetch-boot.test.ts`, `test/interop/_node-peer.ts`, `test/edge/_worker.mjs`.

- [ ] **Step 6: Commit**

```bash
git add src/app/index.ts test/
git commit -m "feat(mesh)!: refuse to export a provider

A provider's value is the object it builds, which cannot cross a JSON wire.
What did cross became an app-scope binding the teacup resolved once at boot
and served from a cache the teapot no longer stood behind. A step is the
shape that travels; the error says so."
```

---

## Task 2: A manifest of steps and routes

**Files**
- Modify: `src/mesh/protocol.ts` (`ScopeEntry`, `Manifest`, `Frame`, `SHAPE.manifest`)
- Modify: `src/mesh/teapot.ts` (`buildManifest`, and wherever the manifest frame is sent)
- Modify: `src/mesh/teacup.ts` (`buildRemote`)
- Modify: `src/mesh/link.ts` (manifest handling and the refuse-policy comparison)
- Test: `test/mesh/protocol.test.ts`, `test/mesh/teapot.test.ts`, `test/mesh/teacup.test.ts`

**Interfaces**
- Produces: `interface Manifest { steps: string[]; routes: RouteEntry[] }`
- Produces: `buildManifest(args: { steps: string[]; routes: RouteEntry[] }): Manifest`
- Produces: `buildRemote(link: Link): { steps: RemoteScopeNode[]; routes: RemoteRoute[] }`
- Gone: `ScopeEntry`, and the `scopes` field of the `manifest` frame

- [ ] **Step 1: Write the failing tests**

```ts
// test/mesh/protocol.test.ts
it('encodes a manifest of step names', () => {
  const frame = decode(encode({ type: 'manifest', v: 1, steps: ['auth'], routes: [] }));
  expect(frame).toEqual({ type: 'manifest', v: 1, steps: ['auth'], routes: [] });
});

it('rejects a manifest whose steps are not an array', () => {
  expect(() => decode(JSON.stringify({ type: 'manifest', v: 1, steps: 'auth', routes: [] }))).toThrow(
    /steps and routes must be arrays/,
  );
});
```

```ts
// test/mesh/teapot.test.ts
it('builds a manifest from step tokens and routes', () => {
  expect(buildManifest({ steps: ['auth'], routes: [{ method: 'GET', pattern: '/u/:id' }] })).toEqual({
    steps: ['auth'],
    routes: [{ method: 'GET', pattern: '/u/:id' }],
  });
});
```

```ts
// test/mesh/teacup.test.ts
it('turns every manifest step into a lazy remote node', async () => {
  const link = { manifest: { steps: ['auth'], routes: [] }, rpc: async () => ({ ok: true }) } as any;
  const { steps, routes } = buildRemote(link);

  expect(routes).toEqual([]);
  expect(steps.map((s: any) => s.name)).toEqual(['auth']);
  expect(await steps[0].run({})).toEqual({ auth: { ok: true } });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run test/mesh/protocol.test.ts test/mesh/teapot.test.ts test/mesh/teacup.test.ts
```

Expected: FAIL — `steps` is not a field, `buildManifest` still wants `providers`.

- [ ] **Step 3: Change the protocol**

In `src/mesh/protocol.ts`, delete `ScopeEntry` (`:45-49`) and replace the `Manifest` interface:

```ts
/**
 * A mesh server's advertised steps and routes.
 *
 * Steps only: a provider's value is the object it builds, which cannot cross a JSON wire, so
 * exporting one is refused at boot (`collectProviders`). Every entry here is request-scope and
 * lazy — the token exists in the teacup's graph, and running it is an RPC.
 */
export interface Manifest {
  steps: string[];
  routes: RouteEntry[];
}
```

In the `Frame` union, replace the `manifest` member:

```ts
  | { type: 'manifest'; v: number; steps: string[]; routes: RouteEntry[] }
```

And its `SHAPE` row:

```ts
  manifest: (frame, bad) => {
    if (!isNumber(frame.v)) bad('missing protocol version');
    if (!Array.isArray(frame.steps) || !Array.isArray(frame.routes)) bad('steps and routes must be arrays');
  },
```

Leave `MESH_PROTOCOL_VERSION` at `1` (D2). Leave `untransportable` alone — a step result can still
carry a `Date` or a `Map`.

- [ ] **Step 4: Change `buildManifest`**

In `src/mesh/teapot.ts`, replace the function at `:43-56`:

```ts
/** Assemble a {@link Manifest} from exported step tokens and buffered routes. */
export function buildManifest(args: { steps: string[]; routes: RouteEntry[] }): Manifest {
  return { steps: [...args.steps], routes: args.routes };
}
```

Then follow the type errors: wherever the teapot sends the `manifest` frame it now sends
`steps: manifest.steps` in place of `scopes: manifest.scopes`.

The only other caller is `buildMeshControl` (`src/app/index.ts:1088`). Update it here, not in Task 3
— a task must leave the tree typechecking, and splitting a signature from its only call site across
two commits leaves a broken commit in history:

```ts
  const manifest = buildManifest({ steps: exportedSteps, routes: exportedRoutes });
```

`exportedProviders` is still destructured on the line above; leave it, Task 3 removes the field.

- [ ] **Step 5: Change `buildRemote`**

In `src/mesh/teacup.ts`, replace the scope loop (`:44-54`):

```ts
/** Turn a link's manifest into local proxy nodes: lazy request-scope steps, and routes. */
export function buildRemote(link: Link): { steps: RemoteScopeNode[]; routes: RemoteRoute[] } {
  const steps: RemoteScopeNode[] = link.manifest.steps.map((token) => ({
    name: token,
    run: async (ctx: any) => ({ [token]: await link.rpc('scope', token, envelopeFrom(ctx)) }),
  }));

  const routes: RemoteRoute[] = link.manifest.routes.map((route) => ({
    method: route.method,
    pattern: route.pattern,
    handler: async (req: RequestEnvelope) => (await link.rpc('route', route.pattern, req)) as ResponseShape,
  }));

  return { steps, routes };
}
```

The RPC `kind` stays `'scope'` — renaming it to `'step'` is a wire change with no benefit, and
`resolveScope` on the teapot side resolves both the same way.

- [ ] **Step 6: Update the refuse policy in `link.ts`**

Find the manifest comparison used by `onManifestChange: 'refuse'` and drop the lifetime half of it:
a returned manifest must still contain every step token the link contributed at boot, and every
route by method plus effective shape. There is no `scope` field left to compare (D6 of the reconnect
plan).

- [ ] **Step 7: Typecheck, then run the mesh suite**

```bash
npm run typecheck && npx vitest run test/mesh/
```

Expected: PASS both. A typecheck failure here means a `manifest` frame send or the `buildMeshControl`
call site was missed.

- [ ] **Step 8: Commit**

```bash
git add src/mesh/ test/mesh/
git commit -m "refactor(mesh)!: a manifest carries step names, not scoped tokens

Every exported token is request-scope now, so the lifetime field had one
value and told a reader nothing. No protocol bump: mesh is alpha, both
peers ship from this repo, and the number should mean incompatibility
between deployed versions."
```

---

## Task 3: The teacup stops splicing providers

**Files**
- Modify: `src/app/index.ts:62,427` (`Registry.exportedProviders`)
- Modify: `src/app/index.ts:808` (delete `invalidateRemoteBindings`)
- Modify: `src/app/index.ts:813-856` (`spliceRemoteScopes`)
- Modify: `src/app/index.ts:1078-1088` (`buildMeshControl`)
- Test: `test/mesh/integration.test.ts`

- [ ] **Step 1: Write the failing test**

This file's teapot fixture opens with `@Provider({ provides: 'config', export: true })`
(`test/mesh/integration.test.ts:6`), and `LocalCtl` declares `@needs('config')`. Task 1 already made
that fixture fail at boot, so converting it is not optional — and converting it is the regression
guard, because a step re-runs where the provider was cached:

```ts
// test/mesh/integration.test.ts — replaces the @Provider fixture at :6
let configCalls = 0;
@Step({ provides: 'config', needs: [], export: true })
class Config {
  run() {
    configCalls += 1;
    return { config: { region: 'mx', call: configCalls } };
  }
}
```

and add, alongside the existing `/local/who` assertion:

```ts
it('re-runs the RPC on every request rather than caching a boot value', async () => {
  // same teapot/teacup pair the '/local/who' test stands up
  expect((await hit('/api/local/who')).config.call).toBe(1);
  expect((await hit('/api/local/who')).config.call).toBe(2);
});
```

- [ ] **Step 2: Run it — it should already pass, and that is the point**

```bash
npx vitest run test/mesh/integration.test.ts -t 're-runs the RPC'
```

Expected: PASS. This is a regression guard, not a red test. The caching bug was only reachable
through provider export, which Task 1 made impossible — once `config` is a step it lands in the
request-scope bucket and already re-runs. The guard exists so that removing the splice in the next
steps cannot quietly reintroduce a cached remote value. Do not manufacture a red state for it.

- [ ] **Step 3: Delete `exportedProviders`**

Remove the field from the `Registry` interface (`:62`) and its initializer (`:427`). In
`buildMeshControl` (`:1078-1088`):

```ts
  const { exportedSteps, exportedRoutes, routePlans, runners } = registry;
  const hasExports = exportedSteps.length || exportedRoutes.length;
  // ...
  const manifest = buildManifest({ steps: exportedSteps, routes: exportedRoutes });
```

- [ ] **Step 4: Delete the remote-provider splice**

In `spliceRemoteScopes`, delete the `rebind` array (`:829`), the `onReconnect` callback that calls
`invalidateRemoteBindings` (`:838`), and the whole `for (const provider of providers)` block
(`:846-856`). Destructure only what is left:

```ts
      const { steps, routes } = buildRemote(link);
```

Then delete `invalidateRemoteBindings` (`:808-810`) and drop the now-unused `container` parameter
from `spliceRemoteScopes` (`:818`) and its call site (`:242`) — `container` was used at `:854` and
nowhere else in the function.

The reconnect handler no longer needs an `onReconnect`. A remote step holds no state between
requests, so a reconnected link is simply usable again on the next RPC.

- [ ] **Step 5: Run the full suite and the typechecker**

```bash
npm run typecheck && npx vitest run test/mesh/
```

Expected: PASS, and no unused-symbol errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/index.ts test/mesh/
git commit -m "refactor(mesh): drop the remote app-scope binding and its rebind seam

A remote provider was registered app-scope, resolved once, and cached for
the process lifetime; invalidateRemoteBindings existed only to un-cache it
on reconnect. With providers gone from the manifest, both go, and a remote
step needs nothing on reconnect because it holds nothing between requests."
```

---

## Task 4: An unreachable teapot does not stop the boot

**Files**
- Modify: `src/app/index.ts:736-776` (`connectUntilDeadline`)
- Modify: `src/app/index.ts:824-843` (the `try` in `spliceRemoteScopes`)
- Modify: `src/graph.ts:54` (the missing-dependency message)
- Test: `test/mesh/boot-retry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/mesh/boot-retry.test.ts
it('boots when a teapot is unreachable and nothing local needs it', async () => {
  const app = createApp({
    modules: [LocalOnlyModule], // declares no needs on a remote token
    mesh: { secret: 's', teapots: [{ url: 'ws://127.0.0.1:9/x', secret: 's' }], bootTimeoutMs: 300 },
  });

  await expect(app.ready()).resolves.toBeUndefined();
});

it('still fails the boot when a local step needs a token the absent teapot owned', async () => {
  const app = createApp({
    modules: [NeedsAuthModule], // a step with needs: ['auth']
    mesh: { secret: 's', teapots: [{ url: 'ws://127.0.0.1:9/x', secret: 's' }], bootTimeoutMs: 300 },
  });

  await expect(app.ready()).rejects.toThrow(/missing dependency: auth[\s\S]*did not connect/i);
});

it('still fails the boot when the teapot refuses the secret', async () => {
  // stand up a teapot with secret 'right', connect with 'wrong'
  await expect(app.ready()).rejects.toThrow(/refused/i);
});
```

- [ ] **Step 2: Run them and watch the first two fail**

```bash
npx vitest run test/mesh/boot-retry.test.ts
```

Expected: the first fails (boot throws on an unreachable teapot), the second fails on the message
(it says `missing dependency: auth` with no mention of the teapot), the third passes already.

- [ ] **Step 3: Make budget exhaustion non-fatal**

In `connectUntilDeadline`, keep the loop, the backoff, the `mesh:boot:retry` event and the
permanent-refusal `throw` (D4). Change the return type to `Promise<Link | undefined>` and replace
the exhaustion branch:

```ts
      // The budget is a grace for a co-deploy, not a requirement. Every export is a lazy step or a
      // proxied route now, so an absent teapot costs a 503 on the requests that need it — and a
      // teacup that refuses to start takes down the half of itself that never needed the teapot.
      if (remaining <= 0) {
        logger.warn(
          `mesh: teapot unreachable after ${attempts} attempt(s) over ${budgetMs}ms ` +
            `(${(error as Error).message}) — starting without it; its steps and routes will 503`,
        );
        return undefined;
      }
```

In `spliceRemoteScopes`, skip a link that came back `undefined`, and record its url:

```ts
      const link = await connectUntilDeadline(/* … */);
      if (!link) {
        absent.push(teapot.url);
        continue;
      }
```

Return `absent` alongside `remoteRoutes` and `meshLinks`.

- [ ] **Step 4: Name the absent teapots in the missing-dependency error**

`topoSort` (`src/graph.ts:46`) is generic and must stay that way. Give it an optional trailing note
instead of mesh knowledge — note the capital S, and that `seedKeys` stays second:

```ts
// src/graph.ts:46
export function topoSort(nodes: GraphNode[], seedKeys: string[], note?: (key: string) => string): GraphNode[] {
```

and at the throw (`src/graph.ts:54`):

```ts
        throw new Error(`missing dependency: ${key} needed by ${node.name}${note?.(key) ?? ''}`);
```

The only call site is `finalizeGraph` (`src/app/index.ts:660`), so thread the note through its
signature rather than reaching for a module-level variable:

```ts
// src/app/index.ts:654 — finalizeGraph gains a trailing optional param
function finalizeGraph(
  registry: Registry,
  logger: Logger,
  warnDepth: number | false = DEEP_GRAPH_WARN,
  missingNote?: (key: string) => string,
): { orderedProviders: GraphNode[]; orderedSteps: GraphNode[] } {
  const { providerNodes, stepNodes, routePlans } = registry;
  const ordered = topoSort([...providerNodes, ...stepNodes], ['req', 'params'], missingNote);
```

`finalize` in `createApp` is the closure that calls it; give it the note built from `absent`:

```ts
  // Without this the error is `missing dependency: auth needed by getUser` and says nothing about
  // the teapot that was away — which is the actual cause every time it is the cause.
  const meshNote = absent.length
    ? () => ` — these teapots did not connect, so their exports are absent: ${absent.join(', ')}`
    : undefined;
```

The note is unconditional on the key rather than per-token on purpose: the teacup does not know
which teapot *would* have owned a token it never received a manifest for, and guessing would put a
wrong url in an error. Listing the ones that were away is true and enough.

- [ ] **Step 5: Run them and watch them pass**

```bash
npx vitest run test/mesh/boot-retry.test.ts
```

Expected: PASS, all three.

- [ ] **Step 6: Commit**

```bash
git add src/app/index.ts src/graph.ts test/mesh/boot-retry.test.ts
git commit -m "feat(mesh): an unreachable teapot no longer stops the teacup from booting

Blocking existed for app-scope exports, which have to resolve at boot
because there is no later. Steps and proxied routes are all later. The
grace budget stays -- a co-deploy still waits -- but exhausting it now
warns instead of throwing. A missing token still fails the boot, and the
error now names the teapots that were away."
```

---

## Task 5: The other runtimes

`npm test` does not cover Deno, Bun or the edge, and this change touches `src/mesh/` and
`src/app/index.ts` — exactly the code AGENTS.md says to run them for.

**Files**
- Modify: `test/deno/mesh.test.ts`, `test/deno/mesh-hardening.test.ts`, `test/deno/mesh-interop.test.ts`,
  `test/deno/mesh-reconnect.test.ts`, `test/bun/mesh.test.ts`, `test/bun/mesh-reconnect.test.ts`
- Modify: `test/interop/_node-peer.ts`, `test/edge/_worker.mjs`

- [ ] **Step 1: Convert every exported provider in the runtime fixtures to a step**

```bash
grep -rn "export: true" test/deno test/bun test/interop test/edge
```

- [ ] **Step 2: Run each runtime suite**

```bash
npm run test:deno
npm run test:bun
npm run test:edge
```

Expected: PASS on all three. The interop peer and the worker both speak the new manifest, so a
mismatch here means one side was missed.

- [ ] **Step 3: Commit**

```bash
git add test/
git commit -m "test(mesh): steps-only exports across Deno, Bun and the edge"
```

---

## Task 6: Say it in the docs

**Files**
- Modify: `README.md` (mesh section)
- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `docs/plans/2026-08-18-mesh-degrade-plan.md` (D6)

- [ ] **Step 1: README**

In the mesh section: only `@Step` and routes are exportable; `@Provider` with `export: true` fails
at boot and why; an unreachable teapot no longer blocks the boot, and its steps and routes `503`;
a missing token still fails the boot, and that is deliberate.

- [ ] **Step 2: CHANGELOG**

Under `[Unreleased]`, with no date and no version heading — the heading is written the day the tag
ships, never earlier.

```markdown
### Changed

- **Mesh (alpha): only steps and routes can be exported.** `@Provider({ export: true })` now fails
  at boot. A provider's value is the object it builds, which cannot cross a JSON wire; what did
  cross became an app-scope binding the teacup resolved once and cached for the life of the
  process. Export a `@Step` instead — it runs on the teapot per request and returns its result.
- **Mesh (alpha): an unreachable teapot no longer stops a teacup from booting.** The
  `bootTimeoutMs` grace still waits for a co-deploy; exhausting it now warns and starts without
  that teapot, whose steps and routes answer `503`. A local step that *needs* an absent token still
  fails the boot, and the error names the teapots that did not connect.
- **Mesh (alpha): the manifest carries step names.** The wire changed without a protocol bump,
  which alpha permits and a stable version would not.
```

- [ ] **Step 3: Note the broken seam in the degrade plan**

Add one line under its D6: `invalidateRemoteBindings` no longer exists — a degraded step swaps a
runner, not a container binding.

- [ ] **Step 4: The full gate**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run complexity:check
npm run test:deno && npm run test:bun && npm run test:edge
```

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md docs/plans/
git commit -m "docs(mesh): steps and routes are what a teapot exports"
```

---

## Size

Smaller than the reconnect work, and mostly subtraction: roughly 120 lines out, 20 in. No new
subsystem, no new configuration, no background loop. The risk is not in the code but in the wire —
both peers change at once, which alpha allows and which the runtime suites are there to prove.

## Branch

From `develop`, per AGENTS.md — `develop` and `main` refuse direct pushes.

```bash
git fetch origin && git checkout -b feat/mesh-steps-only origin/develop
```
