# 🍵 green-tea

> A declarative, type-safe HTTP framework for Node. The request pipeline is an explicit **dependency graph**, not a mutable middleware chain.

`@green-tea/core` — **alpha**. Zero runtime dependencies beyond `reflect-metadata`.

## Why

Express/Fastify middleware is positional, untyped, and globally mutable: order depends on the line you wrote `app.use()` on, `req.user` may or may not exist, and a plugin can quietly delete your body parser. green-tea replaces that model:

- **Declarative, not positional.** You declare what each step *needs* and *produces*. The graph order is computed at boot via topological sort — there is no "put this before that".
- **The type is the contract.** What a handler reads from the context *is* its dependency declaration. The typed `flow` core makes a handler that reads `ctx.user` **fail to compile** if no step produces `user`.
- **Structural plugin isolation.** Plugins get only `bus.on(...)` (observe) and `scope.add(...)` (extend their own scope). There is no API to reorder or delete another scope's steps.
- **Response = return value.** No `Response.json()`. Return data; a `@Transformer` serializes it in a leave phase. Cut a request by `throw`ing a typed signal.
- **Fail-fast boot.** A required provider that can't initialize (e.g. the DB) stops the server from serving — no 500s because a resource wasn't ready.

## Quick look

```typescript
import {
  createApp, Provider, Step, Route, Get, Module,
  Transformer, JsonTransformer, Unauthorized, needs, param,
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
  @Transformer(JsonTransformer)
  getUser(@needs('user') user, @param('id') id) {          // the signature IS the contract
    return { requested: id, you: user };
  }
}

@Module({ mountpoint: '/api', providers: [Database], steps: [Authenticate], controllers: [UserController] })
class ApiModule {}

const app = createApp({ modules: [ApiModule] });
console.log(app.inspect('/api/users/:id'));  // auditable: ordered chain with origins
app.listen(3000);
```

```bash
curl -H 'x-token: u1' http://localhost:3000/api/users/9
# {"requested":"9","you":{"id":"u1","name":"Diego"}}
```

## Argument decorators

The handler signature declares exactly what it wants — in any order, nothing more.

| Decorator | Injects | Forms |
|---|---|---|
| `@needs('user')` | a graph-produced value (boot-validated) | `('key')` |
| `@ctx()` | the whole accumulated context | `()` |
| `@param(...)` | route params | `()` · `('id')` · `(['a','b'])` |
| `@query(...)` | parsed query string | `()` · `('q')` · `(['a','b'])` |
| `@body(...)` | parsed JSON body | `()` · `('field')` · `(['a','b'])` |
| `@headers(...)` | request headers | `()` · `('authorization')` · `(['a','b'])` |

`@needs` keys are validated at boot: if nothing provides the key, `createApp` throws with a clear error instead of serving `undefined`.

## Two layers

1. **Typed functional core (`flow`)** — `flow().step(...).step(...).handle(...)`; step outputs accumulate into the context type (`Acc & Out`). This is where the compile-time guarantee lives.
2. **Declarative decorator layer** — `@Provider/@Step/@Module/@Route/@Get/@Transformer` + argument decorators. Emits runtime metadata, builds and topologically sorts the graph, validates at boot.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit (includes the compile-time-guarantee type test)
npm run build     # emit dist/
```

## Roadmap

- **streams** — native WebSocket/SSE + reactive streams (steps that open an observed channel).
- **mesh** — `teapot`/`teacup`: distributed scopes over a persistent channel with auto-registration. Model: a BEAM/OTP-style cluster, *not* microservices. The core's `resolve()` is already async + transport-agnostic to allow this without a rewrite.
- official plugins (cors, body parsers, auth) — structurally unable to sabotage the global pipeline.

## License

[MIT](./LICENSE) © green-tea contributors. Contributions require a [DCO sign-off](./CONTRIBUTING.md).
