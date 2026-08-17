# Shutdown teardown — Design

**Task:** 2.5 in the [trust-release plan](./2026-08-16-trust-release-plan.md) · Trust Release §14, CTO P0-4 · **Status:** awaiting review, no code written · **Constraint:** no new runtime dependency

---

## The diagnosis

An application closing a database connection today writes `process.on('SIGTERM', …)` by hand, because the framework offers nowhere to put that. `closeApp` (`src/app/index.ts:1009`) closes mesh links, streams and the HTTP server, and knows nothing about plugins or providers. `LifecycleEvent` (`src/bus.ts:2`) has no shutdown event at all — a plugin cannot even *observe* that the app is closing, let alone act on it.

The framework owns the plumbing everywhere else. This is the hole.

### Why the existing `Bus` cannot carry it

`Bus.on` takes a synchronous listener (`src/bus.ts:62`) and `emit` neither awaits nor surfaces failures (`src/bus.ts:85`). Both are deliberate: observers must never break the pipeline. A plugin closing a database connection needs shutdown to *wait for it*, and needs its failure to be visible.

The observability design already settled this rather than leaving it open — `D2` of [2026-08-16-observability-design.md](./2026-08-16-observability-design.md):

> **This is exactly why shutdown teardown does not belong here.** A teardown must be *awaited*; an observer must not be. Same word, opposite guarantees, so they get different surfaces.

Conceptually this is still an event — *"the app is closing, do you have anything to do first?"* — and callers may reasonably think of registering as subscribing. Mechanically it is a separate await-aware registry, because bending `Bus` to do both would cost the guarantee that makes `Bus` safe.

### What "isolation is structural" actually protects

`src/plugin.ts:26` reads *"Hand the plugin ONLY on() and add(). No emit, no other scope. Isolation is structural."* That sentence is load-bearing and it is easy to over-read, so this design states what it does and does not cover — verified against the code, because the answer surprised both people in the conversation that produced this document.

**Enforced today:**

- A plugin receives only `bus.on` and `scope.add` — no `emit`, so it cannot fabricate lifecycle events, and no reach into the registry.
- `setRunner` (`src/app/index.ts:320`) throws on duplicate names, so a plugin cannot silently replace an existing provider or step.
- Plugin nodes carry `origin: 'plugin'` and stay attributable in the graph.

**Not enforced today:**

- `runSteps` passes the live context object to every step and merges its output with `Object.assign(context, output)` (`src/pipeline.ts:73-74`). No collision check. A plugin's step can mutate the context directly and can overwrite any key another step provided.
- `mountPlugins` (`src/app/index.ts:161`) runs *before* `provideBuiltins` (`:162`), and `provideBuiltins` skips anything already registered — so a plugin registering a node named `logger` or `rooms` replaces the builtin.

So the guarantee is about the **registration surface**, not about the **runtime context**. Teardown touches neither: it adds a third thing a plugin may register, and never sees a request context. The context-integrity question is real but pre-existing and out of scope here — it is recorded at the end so it is not lost.

---

## Decisions

### D1 — A teardown registry, not a `Bus` event

One list of callbacks, owned by the app, awaited on close. Not a `LifecycleEvent`, for the reason `D2` of the observability design already gives.

The registry is the entire mechanism. Everything below is a door into it.

### D2 — Three doors, one registry: one order, one failure policy

| Door | Who uses it | Shape |
|---|---|---|
| `hooks: [...]` in `createApp` | an application that wants lifecycle participation and nothing else | `onShutdown()` |
| `PluginApi.onShutdown` | a plugin that also extends the graph | `onShutdown()` |
| `dispose()` on a `@Provider` class | the provider that opened the resource | optional method |

Three entry points, **one** registry, **one** order, **one** failure policy. If they ever acquire separate ordering relative to each other, this design has failed and two mechanisms exist again.

The doors differ by intent, not by semantics. Today the only way into the lifecycle is to write a plugin, and a plugin means *"I want to extend the graph"* — someone who only wants to close a connection is forced to declare an extension they do not want.

### D3 — `PluginApi` gains a property; the `Plugin` signature does not change

`Plugin = (api: PluginApi) => void` is untouched. `onShutdown` joins `bus` and `scope` on the object a plugin already receives. Every existing plugin ignores it and behaves identically.

This is why the hooks framing is better than widening the plugin contract directly: it removes the only break the earlier sketch had. See "What breaks" below — the answer is now *nothing at runtime*.

### D4 — Teardown callbacks receive no arguments

```ts
type TeardownFn = () => void | Promise<void>;
```

State lives where the resource was created, and the closure already holds it:

```ts
class MyPlugin {
  #db = new Pool();
  mount(api: PluginApi) {
    api.onShutdown(() => this.#db.end());   // the closure already has it
  }
}
```

A provider's `dispose()` is the same picture — the instance holds its own connection.

**Nothing needs to cross scopes**, which is what makes a container reference, an app reference, or any transport mechanism unnecessary here. A bus solves *"tell someone I do not know"*. Teardown is *"run this thing I registered"*. Handing a hook a resolver would make the container reachable from a hook and would be a genuine widening — declined.

If an argument is ever needed, adding one to a callback that receives none is additive. The reverse is not.

### D5 — Order is the reverse of boot

Providers boot in topological order (`bootProviders`, `src/app/index.ts:664`), so they tear down in reverse: if `cache` needs `db`, `cache` closes first. Registration order within the same tier is preserved.

Sequential, not parallel. Reverse-topological order only means something if it is respected, and parallel teardown discards it.

### D6 — A failing teardown is logged and shutdown continues

The failure goes to the injectable `Logger` and `close()` still resolves. One plugin's broken teardown must not strand the remaining ones or hang the process.

This mirrors `Bus`'s philosophy — a subscriber cannot break the system — but with the visibility `Bus` lacks. `Bus` swallows silently because no logger existed when it was written; one exists now.

The counter-argument was weighed and rejected: a `close()` that reports success after losing data is arguably worse than one that fails loudly. It loses because the alternative is worse in the common case — a process that will not exit is a worse operational failure than one that exited with a warning in the log, and the warning is not silent.

### D7 — Triggered from each runtime's real close

`app.close()` returns at its `if (!server)` guard on Deno, Bun and the edge (`src/app/index.ts:1026`). Hanging teardown off `app.close()` would make behaviour differ per runtime, which the multi-runtime constraint forbids.

| Runtime | Entry point |
|---|---|
| Node | `app.close()` → `closeApp` |
| Deno | `serveDeno(app).close()` → `closeWithDeadline` |
| Bun | `serveBun(app).close()` → `closeWithDeadline` |
| edge (workerd) | **none — no shutdown exists** |

`serveDeno` and `serveBun` already receive the app, so their `close()` can run its teardown without the user calling two things. `closeWithDeadline` (`src/http/shutdown.ts`) is already shared by both *"so the two adapters cannot drift into different meanings of the same `timeoutMs`"* — the same argument applies here, and it is why teardown belongs in that shared function rather than in each adapter.

Node, Deno and Bun behave identically. **Edge cannot, and no design fixes it**: workerd never closes, so there is nothing to intercept. A plugin that depends on teardown for correctness is broken there. This is a runtime capability difference and belongs in the `runtimes.md` table beside `@Html` file mode and mesh, not in a footnote.

### D8 — Teardown shares the close budget, and `close()` never exceeds `timeoutMs`

`timeoutMs` is a hard ceiling on the whole of `close()`. That is what it is for, and nothing here is allowed to make `close()` take longer than the caller asked for.

- Drain runs first. Teardown runs after, within the same budget.
- `teardownTimeoutMs` is optional and defaults to `timeoutMs` — no separate cap, teardown may use whatever the drain left.
- Setting it lower **reserves**: the drain is bounded to `timeoutMs − teardownTimeoutMs`, so teardown is guaranteed its slice.
- `teardownTimeoutMs > timeoutMs` is rejected at `createApp`, not silently clamped.

> **Open for review — this is an interpretation, not a settled instruction.** "Shares, default `timeoutMs`, may be lowered, never above `timeoutMs`" was the direction given. Whether lowering it should **reserve** (as written above) or merely **cap** teardown's slice was not stated. Reserve is written here because it answers the failure it was raised to answer: with cap-only, a drain that eats the whole budget leaves teardown zero milliseconds and the database does not close. If cap-only is intended, D8 changes and that starvation case stays open.

---

## The contract

```ts
/** A teardown callback. Receives nothing: state lives in the closure that registered it. */
export type TeardownFn = () => void | Promise<void>;

/** Lifecycle participation without extending the graph. Methods are optional so later
 *  stages (onBoot, onReady) can join without a breaking change. */
export interface Hooks {
  onShutdown?: TeardownFn;
}

/** Unchanged except for the third capability. `Plugin` keeps its signature. */
export interface PluginApi {
  bus: { on: Bus['on'] };
  scope: ScopeApi;
  onShutdown(fn: TeardownFn): void;
}

createApp({
  modules: [...],
  plugins: [...],
  hooks: [...],              // new
  shutdownTimeoutMs: 10_000, // existing
  teardownTimeoutMs: 2_000,  // new, optional; <= shutdownTimeoutMs
});

@Provider({ provides: 'db' })
class Db {
  provide() { /* ... */ }
  async dispose() { /* optional; called if present */ }
}
```

### What this costs internally

`collectProviders` (`src/app/index.ts:345`) constructs each provider with `new ProviderClass()` and captures the instance in a closure. **The instance is never stored anywhere reachable**, and `Container.bindings` is private with no iteration, so there is no handle to call `dispose()` on today.

Keeping provider instances requires a new field on `Registry`. That is internal, not public API, and it is the part nobody sees coming from reading "add `onShutdown` to `PluginApi`".

### What breaks

**At runtime: nothing.** `Plugin`'s signature is unchanged, `Hooks` methods are optional, and `dispose()` is called only if present.

**At compile time: nothing either**, given D3. Widening `PluginApi` would have broken anyone constructing one as a literal — typically a test mock — but `onShutdown` is a required property on an object the framework builds and hands out, never one a user implements. Should that turn out to be wrong for some consumer, it goes in the CHANGELOG with the reason: making it optional would force every plugin to check for it and would turn a capability into a conditional forever.

---

## Out of scope, deliberately

- **`onBoot` / `onReady`.** `Hooks` is shaped as an object of optional methods so they can be added without a breaking change, but only `onShutdown` ships. The shape accommodates them; this design does not build them.
- **Request-scope cleanup.** Request values are recomputed per resolve (`src/container.ts`) and are garbage, not resources. Only app-scope teardown is in scope.
- **Edge teardown.** Not possible. Documented, not worked around.
- **A context argument for teardown callbacks.** D4. Additive later if a real case appears.
- **Context integrity.** A plugin's step can overwrite context keys and can replace the `logger` and `rooms` builtins. Real, pre-existing, unrelated to teardown, and recorded here only so the finding is not lost with this conversation.

---

## Verification this design must survive

1. A plugin registering `onShutdown` has it awaited before `close()` resolves — on Node, Deno and Bun, asserted per runtime rather than once.
2. A provider with `dispose()` has it called; one without is skipped.
3. Reverse-topological order: `cache` needing `db` tears down first.
4. A throwing teardown is logged and the remaining ones still run; `close()` resolves.
5. A hanging teardown does not make `close()` exceed `timeoutMs`.
6. `teardownTimeoutMs > shutdownTimeoutMs` throws at `createApp`.
7. An existing plugin that never calls `onShutdown` behaves exactly as before.
8. `close()` on an app with no teardown registered costs nothing measurable — this is not a request path, but it is still on the shutdown path of every app that uses none of it.

## Documentation this design changes

All of these now live in [green-tea-docs](https://github.com/Expressive-Tea/green-tea-docs):

- `guides/plugins.md:7` — states plugins have exactly two capabilities. Becomes three, and the isolation wording needs the precision from the diagnosis above rather than a restatement.
- `guides/runtimes.md:44` — the shutdown table gains teardown, and edge gains its exception.
- `guides/dependency-injection.md:56` — describes what `close()` does; it now does one more thing.
- `README.md` — new public API, per `AGENTS.md:83`.
