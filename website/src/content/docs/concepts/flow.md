---
title: The typed flow core
description: "The functional flow API where the compile-time dependency guarantee lives."
---

The [decorator layer](/guides/dependency-injection/) validates the graph at **boot**. The functional core, `flow`, validates it in the **type checker** — before the program ever runs.

```typescript
import { flow } from '@green-tea/core';

const pipeline = flow()
  .step('db', () => ({ find: (id: string) => id }))
  .step('user', (ctx) => ctx.db.find('u1')); // referencing a missing 'db' would not compile
```

Each `.step(name, fn)` adds its output to the accumulated context **type** (`Acc & Out`). The next step's `ctx` is typed with everything produced so far — so reading `ctx.db` compiles only because a previous step provided `db`. Reference a key nothing produced and it is a **compile error**, not a runtime `undefined`.

This is the strongest guarantee green-tea offers: the type *is* the dependency contract, checked statically. The decorator layer gives you the same graph with boot-time validation and the ergonomics of classes and decorators; `flow` gives you compile-time proof.

:::note
`npm run typecheck` in the repo includes a type-level test that asserts this accumulation behaves — a step that reads a missing key is expected to fail compilation.
:::

See [The dependency graph](/concepts/the-graph/) for how both layers describe the same model.
