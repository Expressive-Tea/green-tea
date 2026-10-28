# green-tea examples

Each file is a runnable app. Run one with `tsx`, which is already a dev dependency:

```bash
npx tsx example/server.ts    # the tour, below
npx tsx example/crud.ts      # a CRUD API over an in-memory store, on :3300
npx tsx example/chat.ts      # WebSocket rooms, on ws://localhost:4100/chat/:room?token=...
npx tsx example/graphql.ts   # GraphQL queries and subscriptions over SSE, on :4200/graphql
```

`server.ts` demonstrates the typed context contract, graph-derived order, `app.inspect()`, a
logger plugin that observes the bus without touching the chain, streams, and a mesh teapot and
teacup. Try it with:

```bash
curl -H 'x-token: u1' http://localhost:3000/api/users/9
```
