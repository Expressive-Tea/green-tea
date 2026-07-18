---
title: Plugins & observability
description: "Extending the app safely via bus.on and scope.add."
---

A plugin is a function that receives the app's API at boot. It gets exactly two
capabilities: **observe** the running system through `bus.on(...)`, and **extend its own
scope** through `scope.add(...)`. That's the whole surface — and it's deliberately narrow.

```typescript
const logger = (api: any) => {
  api.bus.on('request:step:enter', (p: any) => console.log(`→ ${p.name}`));
  api.bus.on('stream:open', (p: any) => console.log(`stream open ${p.name}`));
  api.bus.on('mesh:rpc:error', (p: any) => console.error('mesh rpc failed', p.error));
};

const app = createApp({ modules: [ApiModule], plugins: [logger] });
```

## Isolation is structural

A plugin can add steps and providers to **its own scope** via `scope.add(...)`. It
**cannot** reorder or delete another scope's steps. The graph — not a policy check —
enforces this: each scope owns its nodes, and a plugin has no handle on anyone else's.
There's no ordering hook to abuse and no step registry to mutate. If you want a plugin to
influence execution, it does so by contributing a node with declared `needs`/`provides`,
and the framework computes where that node lands.

:::note
Because execution is per-route (a route runs only the transitive closure of its handler's
`@needs`), a plugin step that should run on **every** route must produce nothing — add it
with `provides: []`. A step that produces no token has nothing to gate on, so the framework
runs it unconditionally. See [The graph](/docs/concepts/the-graph/) for how the closure is
computed.
:::

## Lifecycle & request events

Subscribe to events on the `Bus` to observe boot, per-request execution, streaming, and
mesh activity without touching the pipeline itself:

```typescript
api.bus.on('boot:provider:ready', (p: any) => { /* ... */ });
api.bus.on('request:step:enter', (p: any) => { /* ... */ });
api.bus.on('request:step:leave', (p: any) => { /* ... */ });
```

The full event vocabulary:

- `boot:provider:*` — provider lifecycle during boot
- `request:step:*` — a step entering/exiting during a request
- `stream:open | stream:close | stream:error` — SSE/WS stream lifecycle
- `mesh:connect | mesh:disconnect | mesh:rpc:error` — mesh link and RPC activity
- `plugin:mounted` — a plugin finished mounting

Observation is read-only: handlers see the event payload but can't alter control flow. To
change behavior, contribute a node to your scope — see
[Dependency injection](/docs/guides/dependency-injection/).
