---
title: Getting started
description: Install green-tea, configure TypeScript decorators, and build your first graph-based route.
---

## Scaffold it

The fastest path is [matcha](/guides/cli/), green-tea's CLI. It writes a project that runs on the first command — no wiring, no config:

```bash
matcha new my-api            # --runtime node (default) | deno | bun
cd my-api && matcha run
```

## Or install by hand

```bash
npm install @green-tea/core reflect-metadata
# optional, only if you use them:
npm install ws       # WebSocket routes (@Ws) and mesh
npm install busboy   # multipart/form-data file uploads
```

green-tea runs on **Node ≥ 18, Deno, Bun, and the edge** — the same app, you only swap the entry point. This guide uses Node; see [runtimes](/guides/runtimes/) for the others and for what the edge can't offer.

green-tea uses **legacy** TypeScript decorators. Enable them in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "target": "es2020",
    "moduleResolution": "node"
  }
}
```

You do **not** need `emitDecoratorMetadata` — green-tea records argument positions explicitly. See [Why legacy decorators](/concepts/the-graph/#why-legacy-decorators) for the rationale.

## Your first app

A provider produces a value, a step transforms the request context, and a controller handler declares exactly what it needs:

```typescript
import {
  createApp, Provider, Step, Route, Get, Module,
  Unauthorized, needs, param,
} from '@green-tea/core';

@Provider({ provides: 'db' })
class Database {
  provide() {
    const users = { u1: { id: 'u1', name: 'Diego' } };
    return { db: { find: (token: string) => users[token] ?? null } };
  }
}

@Step({ provides: 'user', needs: ['db', 'req'] })
class Authenticate {
  run(ctx) {
    const user = ctx.db.find(ctx.req.headers['x-token']);
    if (!user) throw new Unauthorized('invalid token');   // cut the request
    return { user };                                       // continue
  }
}

@Route('/users')
class UserController {
  @Get('/:id')
  getUser(@needs('user') user, @param('id') id) {          // the signature IS the contract
    return { requested: id, you: user };
  }
}

@Module({ mountpoint: '/api', providers: [Database], steps: [Authenticate], controllers: [UserController] })
class ApiModule {}

const app = createApp({ modules: [ApiModule] });
console.log(app.explain('/api/users/:id')); // auditable: the ordered chain, with origins
app.listen(3000);
```

```bash
curl -H 'x-token: u1' http://localhost:3000/api/users/9
# {"requested":"9","you":{"id":"u1","name":"Diego"}}
```

The handler asked for `user` via `@needs('user')`. If nothing in the graph produced `user`, `createApp` would **throw at boot** with a "did you mean…" hint — you never serve `undefined`.

## Where to next

- [The dependency graph](/concepts/the-graph/) — the mental model behind everything.
- [Dependency injection](/guides/dependency-injection/) — providers, steps, and modules in depth.
- [Argument decorators](/guides/arguments/) — everything a handler can inject.
- [Streaming & real-time](/guides/streaming/) — SSE, WebSocket, and ndjson from one primitive.
