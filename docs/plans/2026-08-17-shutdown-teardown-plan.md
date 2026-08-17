# Shutdown teardown — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Design:** [2026-08-17-shutdown-teardown-design.md](./2026-08-17-shutdown-teardown-design.md) — reviewed, D1–D8 settled. Do not re-decide them here.

**Goal:** Give plugins, providers and applications somewhere to put teardown, so closing a database connection stops meaning `process.on('SIGTERM', …)` by hand. Closes Task 2.5 of the [trust-release plan](./2026-08-16-trust-release-plan.md); Trust Release §14, CTO P0-4.

**Architecture:** A new `src/lifecycle.ts` holds the registry and nothing else. `src/plugin.ts` and `src/app/index.ts` gain doors into it; `src/app/index.ts` (`closeApp`) and `src/http/shutdown.ts` (`closeWithDeadline`) gain the call that drains it. No new runtime dependency — `reflect-metadata` stays the only one.

**The thing to keep hold of:** three doors, one registry, one order, one failure policy. Any task that gives a door its own ordering or its own error handling has broken D2, whatever the tests say.

---

## Order

Tasks 1–3 build the mechanism and the doors; nothing observable changes until Task 4 wires it into `close()`. Task 5 is the runtime parity that D7 demands and is the one most likely to surface a surprise, so it does not go last. Documentation is Task 7 because it should describe the finished API rather than be rewritten twice.

---

### Task 1: The registry

**Files:**
- Create: `src/lifecycle.ts`
- Create: `test/lifecycle.test.ts`

The whole mechanism, with no knowledge of plugins, providers, apps or HTTP.

```ts
export type TeardownFn = () => void | Promise<void>;
```

It needs: register a callback, and run everything registered — sequentially, in reverse registration order (D5), awaiting each, catching each (D6), never throwing. A failing callback is reported through the injectable `Logger` and the next one still runs.

Keep the timeout **out** of here. Bounding is the caller's job, and it is already solved twice over by `closeApp` and `closeWithDeadline`; a third implementation is how the three drift into different meanings of the same number.

Tests: order is reverse of registration; a throwing callback is logged and does not stop the rest; a rejecting async callback is treated the same; an empty registry resolves; running twice does not re-run callbacks (`close()` is called twice by more real applications than anyone expects).

### Task 2: The plugin and hook doors

**Files:**
- Modify: `src/plugin.ts`
- Modify: `src/app/index.ts` — `mountPlugins`, `createApp` options
- Modify: `src/app/types.ts` — `Hooks` on the public options
- Modify: `test/plugin.test.ts`

`PluginApi` gains `onShutdown(fn: TeardownFn): void`, bound to the app's registry. `mountPlugin`'s comment at `src/plugin.ts:26` currently says a plugin gets `on()` and `add()` and nothing else; it now gets three things, and the comment says which and why — the isolation wording in the design's diagnosis is the precise version, not "isolation is gone".

`createApp({ hooks })` takes `Hooks[]`, an object of optional methods so `onBoot`/`onReady` can join later without a breaking change. Only `onShutdown` exists now.

Tests: a plugin registering `onShutdown` lands in the registry; a plugin that never calls it behaves exactly as before (D3 — this is the no-break guarantee, so it gets an explicit test rather than an assumption); hooks and plugins interleave in one order rather than running as two groups.

### Task 3: Provider `dispose()`

**Files:**
- Modify: `src/app/index.ts` — `collectProviders`, `Registry`
- Modify: `test/app.test.ts`

`collectProviders` (`src/app/index.ts:345`) builds each provider with `new ProviderClass()` and captures the instance in a closure where nothing can reach it. Keep the instances on `Registry` so a `dispose()` can be called.

Registration order must follow boot order, not declaration order, so that D5's reverse-topological teardown falls out of the registry's reverse-registration rule rather than needing a second sort. That means registering a provider's `dispose()` as it boots in `bootProviders` (`:664`), not when it is collected.

A provider that failed to boot must not have `dispose()` called — it never provided anything. Optional providers that degraded (`degradedProviders`) are exactly this case and already tracked.

Tests: `dispose()` is called; a provider without one is skipped; `cache` needing `db` tears down first; a provider that failed to boot is not disposed.

### Task 4: Drain the registry on close — Node

**Files:**
- Modify: `src/app/index.ts` — `closeApp`
- Modify: `test/app.test.ts`

Teardown runs **after** the server drain and **before** `close()` resolves (D8): in-flight requests may still need the database while draining.

The budget: `timeoutMs` is a hard ceiling on the whole of `close()`. `teardownTimeoutMs` **unset** means no reservation — the drain may use all of `timeoutMs` and teardown gets what is left, possibly nothing. **Set**, it reserves: the drain is bounded to `timeoutMs − teardownTimeoutMs`. `teardownTimeoutMs > shutdownTimeoutMs` throws at `createApp` rather than being clamped silently.

`closeApp` already arms a timer before `finish` exists, for a reason its comment spells out at length. Read that comment before touching the ordering.

Tests: a registered teardown is awaited before `close()` resolves; a hanging teardown does not let `close()` exceed `timeoutMs`; a slow drain plus a set `teardownTimeoutMs` still leaves teardown its reserved slice; `teardownTimeoutMs > shutdownTimeoutMs` throws at `createApp`.

### Task 5: Runtime parity — Deno and Bun

**Files:**
- Modify: `src/http/shutdown.ts` — `closeWithDeadline`
- Modify: `src/deno.ts`, `src/bun.ts`
- Modify: `test/deno/*`, `test/bun/*`

`app.close()` returns at its `if (!server)` guard on Deno and Bun (`src/app/index.ts:1026`), so teardown cannot hang off it without behaviour differing per runtime — which the multi-runtime constraint forbids (D7).

`serveDeno(app)` and `serveBun(app)` already hold the app, so their `close()` runs the teardown and the user calls one thing, not two. It goes in `closeWithDeadline` rather than in each adapter, for the reason that function already exists: so the two cannot drift into different meanings of the same `timeoutMs`.

Deno cannot escalate from graceful to forced — its deadline bounds how long `close()` waits, not when connections die. That asymmetry already exists and this must not make it worse.

These suites are **not** in `npm test`. Run `npm run test:deno` and `npm run test:bun` explicitly, and do not report this task done on the strength of vitest passing.

Tests, per runtime rather than once: a teardown registered on a Deno/Bun app is awaited by that server's `close()`.

### Task 6: Edge — document the hole, do not paper over it

**Files:**
- Modify: `src/edge.ts` — doc comment only

workerd never closes, so there is nothing to intercept and no design fixes it. A plugin depending on teardown for correctness is broken there.

No shim, no fake `close()`, no best-effort call on an unload event that does not exist. The only change is a doc comment stating it, so someone reading `edgeHandler` learns it there rather than in production. The user-facing half is Task 7.

### Task 7: Documentation

**Files:** all in [green-tea-docs](https://github.com/Expressive-Tea/green-tea-docs)
- Modify: `src/content/docs/guides/plugins.md` — line 7 says plugins have exactly two capabilities; it is three now, and the isolation sentence needs the design's precision rather than a restatement
- Modify: `src/content/docs/guides/runtimes.md` — the shutdown table gains teardown, and edge gains its row
- Modify: `src/content/docs/guides/dependency-injection.md` — line 56 describes what `close()` does
- Modify: `README.md` in core — new public API, per `AGENTS.md:83`
- Modify: `CHANGELOG.md` in core

Two repositories, one change. This is the first real test of the seam Phase 4 opened, and nothing fails if it is skipped — which is the point of doing it in the same session rather than leaving it to a follow-up.

---

## Out of scope

- `onBoot` / `onReady`. `Hooks` is shaped to accommodate them; this plan does not build them.
- Request-scope cleanup. Request values are recomputed per resolve and are garbage, not resources.
- Edge teardown. Not possible.
- A context argument for teardown callbacks (D4). Additive later if a real case appears.
- Context integrity — a plugin's step can overwrite context keys and replace the `logger` and `rooms` builtins. Real, pre-existing, and recorded in the design's out-of-scope section so it is not lost.

## Verification

The design's list, restated as the gate for calling this done:

1. A plugin's `onShutdown` is awaited before `close()` resolves — asserted on Node, Deno and Bun separately.
2. A provider with `dispose()` has it called; one without is skipped; one that failed to boot is not disposed.
3. Reverse-topological order: `cache` needing `db` tears down first.
4. A throwing teardown is logged, the rest still run, `close()` resolves.
5. A hanging teardown does not make `close()` exceed `timeoutMs`.
6. `teardownTimeoutMs > shutdownTimeoutMs` throws at `createApp`.
7. An existing plugin that never calls `onShutdown` behaves exactly as before.
8. `close()` on an app with no teardown registered costs nothing measurable.

Plus the gates every change here passes: `npm run lint`, `npm run complexity:check`, `npm run typecheck`, `npm test`, and — because Task 5 exists — `npm run test:deno`, `npm run test:bun`, `npm run test:edge`.
