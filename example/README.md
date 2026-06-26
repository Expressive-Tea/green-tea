````markdown
# green-tea example

```bash
npx ts-node example/server.ts   # or: npm run build && node dist/example/server.js
curl -H 'x-token: u1' http://localhost:3000/api/users/9
```

Demonstrates: typed context contract, graph-derived order, `app.inspect()`,
and a logger plugin that observes the bus without touching the chain.
````
