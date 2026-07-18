---
title: Testing
description: "Swap any node with createApp overrides for fast, isolated tests."
---

Any provider or step is addressable by its **token**, so you can swap it for a test double
at construction time — no monkey-patching, no module rewiring.

## Override tokens in tests

Pass `overrides` to `createApp`. Each key is a token; each value is either a plain object
(wrapped as `{ token: value }`) or a function runner:

```typescript
const app = createApp({
  modules: [ApiModule],
  overrides: {
    db: { find: () => ({ id: 'test-user' }) },   // plain object — wrapped as { db: value }
    user: () => ({ user: { id: 'stub' } }),       // function runner
  },
});
```

Overrides replace **only** the named token's runner; the rest of the graph is untouched. The
route still runs its full closure — you've just substituted what one node produces.

:::note
An override for an unknown token throws. The set of tokens is validated against the real
graph, so a typo'd or stale override is a construction-time error, not a silent no-op.
:::

This pairs well with [`app.explain(route)`](/docs/guides/introspection/) — explain the chain to
see which tokens a route actually depends on, then override exactly those.
