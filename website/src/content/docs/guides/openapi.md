---
title: OpenAPI
description: "Generate a structural OpenAPI 3.1 document from the route graph."
---

Because the request pipeline is [data you can read](/docs/concepts/the-graph/), green-tea can project it — the same way it renders [Mermaid/DOT](/docs/guides/introspection/), it emits **OpenAPI**.

## `app.openapi()`

```typescript
const app = createApp({ modules: [ApiModule] });
const spec = app.openapi({ title: 'My API', version: '1.0.0' });
// → OpenAPI 3.1 document
```

It reads the routes and handler signatures and produces, for each route:

- the **path**, templated — `/users/:id` → `/users/{id}`, constrained `:id(\d+)` → `{id}`, catch-all `:path*` → `{path}`;
- the **explicitly declared method**, including `@Head` and `@Options`;
- **parameters** — path params from the pattern, plus query/header params from the handler's `@query` / `@headers` / `@header` decorators;
- a **request body** entry for routes that read `@body()`;
- the systematic **responses** — `200`, a `422` when any argument is schema-validated, and `500`.

WebSocket routes are omitted (they aren't request/response).

A constrained path parameter remains a string parameter and carries its route expression as `schema.pattern`. Only declared operations appear: implicit HEAD and automatic OPTIONS fallbacks are runtime conveniences and are not invented in the OpenAPI document.

## Serve it — `devOpenapi`

Opt in to a `GET /__openapi__` endpoint that returns the document as JSON — point Swagger UI, Redoc, or a codegen client at it:

```typescript
const app = createApp({ modules: [ApiModule], devOpenapi: true });
// GET /__openapi__  →  application/json
```

## What's structural (and what isn't yet)

This is a **structural** spec: paths, methods, parameters, which routes take a body, and the standard error responses. What it does **not** include yet:

- **Request/response body schemas.** [Standard Schema](/docs/guides/validation/) (zod/valibot/arktype) validates input but does not expose a JSON Schema representation, so body shapes are documented generically. Parameter types default to `string`.

Full schemas — declared and enforced on the way out via a `@Produce(schema)` decorator that also validates responses — are on the roadmap for the stable release. For beta, the structural document already drives Swagger UI, client codegen, and API diffing.
