---
title: Graph introspection
description: "explain, graph, toMermaid, and the graph endpoint."
---

Because the request/boot pipeline is an explicit [dependency graph](/concepts/the-graph/),
you can inspect it directly — visualize the whole thing, or explain exactly which nodes a
single route runs.

## Visualize with Mermaid

`app.toMermaid()` renders a flowchart of every node and route. `app.toDOT()` produces the
same graph as Graphviz DOT.

```typescript
console.log(app.toMermaid());  // flowchart diagram of all nodes and routes
```

Enable a live `GET /__graph__` endpoint — it renders an HTML viewer with Mermaid, or the
raw Mermaid source with `Accept: text/plain`:

```typescript
const app = createApp({ modules: [ApiModule], devGraph: true });
// GET /__graph__            → HTML viewer
// GET /__graph__ (text/plain) → raw Mermaid source
```

:::caution
`devGraph` exposes your graph structure over HTTP. Keep it on in development; leave it off
in production.
:::

## Explain a route

`app.explain(route)` returns the exact execution chain for one route — the ordered nodes,
each with its kind, origin, and declared `needs`/`provides`:

```typescript
const e = app.explain('/api/users/:id');
// { pattern, method, transport, chain: [{ name, kind, origin, needs, provides }, ...] }
console.log(e.chain.map((n) => `${n.kind}:${n.name}`));
// → ['provider:db', 'step:user', 'handler:getUser']
```

The chain is the transitive closure of the handler's `@needs` — the same set the framework
actually runs for that route, and nothing more.

`app.graph()` returns the underlying graph structure programmatically if you'd rather walk
it yourself than render it.

## Degraded optional providers

`app.degraded()` returns the names of optional providers that are running in a **degraded**
state — for example, an optional dependency that failed to initialize but didn't abort boot.
Use it as a health signal to surface partial availability.
