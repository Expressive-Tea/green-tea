# green-tea examples

Each file is a runnable app. Run one with `tsx`, which is already a dev dependency:

```bash
npx tsx example/server.ts    # the tour, below
npx tsx example/crud.ts      # a CRUD API over an in-memory store, on :3300
npx tsx example/chat.ts      # WebSocket rooms, on ws://localhost:4100/chat/:room?token=...
npx tsx example/graphql.ts   # GraphQL queries and subscriptions over SSE, on :4200/graphql
npx tsx example/mesh/billing.ts  # mesh teapot on :3401; then, in a second terminal:
npx tsx example/mesh/shop.ts     # mesh teacup on :3400 (see Mesh, below)
```

`server.ts` demonstrates the typed context contract, graph-derived order, `app.inspect()`, a
logger plugin that observes the bus without touching the chain, streams, and a mesh teapot and
teacup. Try it with:

```bash
curl -H 'x-token: u1' http://localhost:3000/api/users/9
```

## Mesh: one REST API across two processes

`example/mesh/` splits a small shop across two nodes. Mesh is alpha and needs
`createApp({ experimental: true })`; don't ship it to production yet.

- **`billing.ts`** is the teapot. It owns the ledger (never exported: a mesh export carries data,
  not handles) and exports a step, `balance`, plus its REST routes under `/billing`.
- **`shop.ts`** is the teacup. Its `GET /shop/checkout/:customer` does `@needs('balance')` exactly
  as it would a local step; only the mesh config says that `balance` lives on billing. It also
  serves billing's routes as if they were its own.

Start billing first: checkout needs `balance` at boot, and a teacup refuses to boot without a
producer for a token it needs.

```bash
npx tsx example/mesh/billing.ts      # teapot on :3401
npx tsx example/mesh/shop.ts         # teacup on :3400
```

```bash
curl localhost:3400/shop/checkout/ada                      # {"customer":"ada","due":40,"canCheckout":false}
curl -X POST -H 'content-type: application/json' \
     -d '{"amount":10}' localhost:3400/billing/invoices/ada   # served by billing, through the shop
curl localhost:3400/billing/invoices/ada                   # both invoices
```

Stop billing and the shop keeps running: anything that needs billing answers `503` with
`retry-after` while the link reconnects. Start billing again and the shop reconnects on its own
within about a second. The ledger is in memory, so it starts over.

The secret is `demo-secret` unless `MESH_SECRET` is set on both sides. `BILLING_PORT`, `SHOP_PORT`
and `BILLING_URL` move things around. `ws://` works here because both nodes are on loopback; to
another machine use `wss://`, or `createApp` refuses the link.

`test/examples/mesh.test.ts` runs this walkthrough with billing in a real child process, killed and
restarted, so the demo cannot drift from what core does.
