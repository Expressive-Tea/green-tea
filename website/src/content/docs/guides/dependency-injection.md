---
title: Dependency injection
description: "Providers, steps, and modules, and how values flow through the graph."
---

In green-tea the request pipeline is an explicit **dependency graph**. You declare what each
piece needs and produces; the framework computes the order, validates the wiring at boot, and
runs only the slice a route actually depends on. You never write "put this before that."

There are three building blocks:

- A **provider** is an app-scope singleton — constructed once, its value memoized for the
  lifetime of the app.
- A **step** runs per request and transforms the context.
- A **module** sets a mountpoint and wires providers, steps, and controllers together.

A handler's **argument decorators are its dependency declaration** — ask for what you want, in
any order. If you `@needs` a token nothing produces, you get a **boot error**, not an
`undefined` at runtime.

## The full example

```typescript
import 'reflect-metadata';
import { createApp, Provider, Step, Route, Get, Module, Unauthorized, needs, param } from '@green-tea/core';

@Provider({ provides: 'db' })
class Database {
  provide() { return { db: { find: (id: string) => ({ id, name: 'Diego' }) } }; }
}

@Step({ provides: 'user', needs: ['db', 'req'] })
class Authenticate {
  run(ctx: any) {
    const user = ctx.db.find(ctx.req.headers['x-token']);
    if (!user) throw new Unauthorized('bad token'); // throw = short-circuit the pipeline
    return { user };                                // return = continue, merge into ctx
  }
}

@Route('/users')
class UserController {
  @Get('/:id')
  getUser(@needs('user') user: any, @param('id') id: string) {
    return { requested: id, you: user };           // auto-serialized as JSON
  }
}

@Module({ mountpoint: '/api', providers: [Database], steps: [Authenticate], controllers: [UserController] })
class ApiModule {}

const app = createApp({ modules: [ApiModule] });
await app.listen(3000);
// GET /api/users/9  (header x-token) → { "requested": "9", "you": { "id": "...", "name": "Diego" } }

await app.close();   // graceful shutdown: drains in-flight requests, closes streams + mesh links
```

## `@Provider` — app-scope, memoized

A provider produces a value once, when the app boots, and reuses it for every request. Its
`provide()` method returns an object whose keys become tokens in the graph — here `db`.

```typescript
@Provider({ provides: 'db' })
class Database {
  provide() { return { db: { find: (id: string) => ({ id, name: 'Diego' }) } }; }
}
```

Because it's app-scope, a provider is the right home for things you build once and share:
database clients, config, connection pools.

:::note
An optional provider (`optional: true`) that throws on boot does **not** abort startup — it is
left unregistered and logged, and the failure surfaces at request time for routes that need it.
Query the degraded set with `app.degraded()` or listen for the `boot:provider:fail` bus event.
:::

## `@Step` — request-scope, transforms the context

A step runs once per request. Its `run(ctx)` receives the accumulated context and either:

- **returns an object** → the pipeline continues and the object is merged into `ctx`, or
- **throws** → the request short-circuits (here `Unauthorized` becomes a `401`).

```typescript
@Step({ provides: 'user', needs: ['db', 'req'] })
class Authenticate {
  run(ctx: any) {
    const user = ctx.db.find(ctx.req.headers['x-token']);
    if (!user) throw new Unauthorized('bad token'); // throw = short-circuit the pipeline
    return { user };                                // return = continue, merge into ctx
  }
}
```

This step `provides: 'user'` and `needs: ['db', 'req']` — so green-tea knows the `db` provider
and the built-in `req` must resolve before it runs, and it topologically sorts accordingly.

## How `needs` / `provides` build the graph

Every node declares what it **produces** (`provides`) and what it **consumes** (`needs`). The
framework reads those declarations and computes a topological order — you never specify
ordering by hand. A handler's argument decorators extend the same graph: `@needs('user')` on a
parameter is a dependency edge exactly like a step's `needs`.

Because the graph is explicit, **each route runs only the transitive closure of its handler's
`@needs`** — nothing else.

:::caution[Per-route execution]
A route that doesn't `@needs('user')` does **not** run the `Authenticate` step. A cross-cutting
*enforcement* step (e.g. auth that throws `401`) only protects routes that actually `@needs`
its token. To run something on **every** route regardless of needs (logging, audit, a global
guard), add it as a **plugin step** via `scope.add({ ..., provides: [] })` — steps that produce
nothing run unconditionally. Don't rely on a token-providing step to guard routes that don't
declare it.
:::

## `@Module` — mountpoint and wiring

A module ties everything together: a `mountpoint` prefix for the routes, and the lists of
`providers`, `steps`, and `controllers` that belong to it.

```typescript
@Module({ mountpoint: '/api', providers: [Database], steps: [Authenticate], controllers: [UserController] })
class ApiModule {}
```

Pass modules to `createApp({ modules: [ApiModule] })` to assemble the app.

## Boot validation of `@needs`

The payoff of declaring dependencies is that the wiring is checked before a single request is
served. When you `@needs` a token, green-tea verifies some provider or step actually produces
it. If nothing does, **`createApp` throws with a clear error** instead of letting your handler
receive `undefined`. Boot fails loudly, so you never serve `undefined`.

## Where to go next

- New to green-tea? Start with [Getting started](/getting-started/).
- The mental model behind all of this: [The graph](/concepts/the-graph/).
- Everything a handler can inject: [Argument decorators](/guides/arguments/) and the
  [decorator reference](/reference/decorators/).
- Coerce and validate injected values with Standard Schema: [Validation](/guides/validation/).
- Return an `AsyncIterable` to push data over time: [Streaming](/guides/streaming/).
