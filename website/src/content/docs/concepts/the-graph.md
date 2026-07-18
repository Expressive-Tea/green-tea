---
title: The dependency graph
description: "How green-tea models the request and boot pipeline as an explicit dependency graph."
---

Most frameworks make you keep the whole request in your head: which middleware ran, whether `req.user` exists by now, what order things fire in, which plugin quietly deleted your body parser. That bookkeeping is where bugs live.

green-tea puts the request **on the page**. You declare what each unit **needs** and **produces**; the framework computes the order, checks the wiring, and can print the whole thing.

## needs / provides

Every node declares its inputs and outputs:

- A **provider** produces an app-scope value (a database handle, a config object) — resolved once at boot and cached.
- A **step** reads the request context and merges new keys into it (authentication producing `user`, say) — runs per request.
- A **handler** (a route method) declares, through its argument decorators, exactly which keys it depends on.

green-tea builds a directed graph from these declarations and **topologically sorts** it. You never write "put this before that" — order is derived from `needs`/`provides`.

```typescript
@Step({ provides: 'user', needs: ['db', 'req'] })   // user depends on db and req
class Authenticate { /* ... */ }
```

## Why it matters

- **No ordering bugs.** There's no positional `app.use()` sequence to get wrong; the sort is the order.
- **Each route runs only its slice.** A route runs the transitive closure of what its handler `@needs` (plus always-run observer steps) — an auth step doesn't run on a public route.
- **Boot fails loudly.** If a handler needs a key nothing provides, `createApp` throws at boot with a "did you mean…?" hint — you never serve `undefined`.
- **You can read it.** `app.explain(route)` prints the ordered chain with origins; `app.graph()` / `GET /__graph__` render it as a diagram. See [Graph introspection](/docs/guides/introspection/).

## Two layers

green-tea exposes the graph two ways:

1. **The typed functional core, [`flow`](/docs/concepts/flow/)** — the compile-time guarantee. A handler that reads `ctx.user` fails to **compile** if no step produces `user`.
2. **The declarative decorator layer** — `@Provider` / `@Step` / `@Module` / `@Route` / `@Get` plus [argument decorators](/docs/guides/arguments/). Emits runtime metadata, builds and sorts the graph, and validates at boot.

Both describe the same graph; pick the ergonomics you want.

## Why legacy decorators

green-tea uses **legacy** (experimental) TypeScript decorators — set `experimentalDecorators: true` in your `tsconfig`. This is a design decision, not inertia.

The argument-injection API (`@param`, `@query`, `@body`, `@header`, `@needs`, `@ctx`, `@inbound`, `@abort`) relies on **parameter decorators**, and the TC39 standard decorators proposal (Stage 3) deliberately does **not** include them. There is no standards-track way to decorate a parameter today, so `handler(@param('id') id: string)` is only expressible with legacy decorators.

"Stage 3" also means *not finalized* — the proposal can still change before engines ship it. green-tea tracks it and will revisit if parameter injection ever gets a standard path. It does **not** rely on `emitDecoratorMetadata` / `design:type` reflection — argument positions are recorded explicitly — so this is the only legacy surface it depends on.
