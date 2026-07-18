---
title: Validation
description: "Validate and coerce input with Standard Schema (zod, valibot, arktype)."
---

`@body`, `@query`, `@headers`, and `@param` accept an optional **Standard Schema**
(the [`~standard` interface](https://standardschema.dev) shared by zod, valibot, arktype,
and others). green-tea's core has **zero runtime dependency** on any of them — bring
whichever validator you already use.

```typescript
import { z } from 'zod';
import { Route, Post, body } from '@green-tea/core';

const CreateUser = z.object({ email: z.string().email() });

@Route('/users')
class UserController {
  @Post('/')
  create(@body(CreateUser) user: { email: string }) {
    return { created: user.email };
  }
}
```

## Parsed value replaces the argument; `ctx` stays raw

The value the handler receives is the schema's **parsed/coerced output**, not the raw
input — `ctx.body` (via `@ctx()` or a `@needs`-fed step) stays exactly what the transport
parsed. Query strings are always strings on the wire, so a schema is often the coercion
point:

```typescript
const ListQuery = z.object({ page: z.coerce.number() });

@Get('/list')
list(@query(ListQuery) q: { page: number }) {
  return { page: q.page, isNum: typeof q.page === 'number' }; // GET /list?page=2 → true
}
```

## Where the schema goes (the one asymmetry)

:::note[Access shape]
`@param('id', Schema)` takes the key in slot 1 and the schema in slot 2 — `@param` always
needs a name to say which route param it binds. `@body(Schema)`, `@query(Schema)`, and
`@headers(Schema)` take the schema as their **only** argument, validating the whole parsed
object (all of `body`/`query`/`headers`).
:::

See [Argument decorators](/docs/guides/arguments/) for the full slot semantics of each decorator.

## Failure: 422 with per-field issues

A failing schema short-circuits the request with **422**:

```json
{ "error": "Validation failed", "source": "body", "issues": [{ "path": "email", "message": "Invalid email" }] }
```

`source` is which envelope failed (`'body' | 'query' | 'params' | 'headers'`); `issues` is
the schema's issues flattened to `{ path, message }` (`path` is dot-joined).

## Caveats

- **Fail-fast.** Arguments validate in order; the **first** failing one throws — later args in
  the same handler are not checked in that request.
- **Steps see raw input.** Only the resolved handler argument is coerced/validated; a `@Step`
  reading the same data via `ctx.body`/`ctx.query`/etc. always sees the untouched value.
- **A throwing schema is a 500, not a 422.** The Standard Schema contract says `validate()`
  returns `{ issues }` on failure — it isn't supposed to throw. If it does anyway, that
  propagates as an uncaught error (→ 500), since it signals a bug in the schema, not user input.
- **Async schemas are awaited** — `validate()` returning a `Promise` works transparently.

:::note[Not covered yet]
Response/output validation, validating a `@Step`'s own inputs, and mesh remote-route
validation are all out of scope for this feature.
:::

## Related

- [Argument decorators](/docs/guides/arguments/) — every slot decorator and its parsing rules
- [File uploads / multipart](/docs/guides/uploads/) — how multipart bodies are parsed before validation
- [`createApp` reference](/docs/reference/createapp/) — app construction options
