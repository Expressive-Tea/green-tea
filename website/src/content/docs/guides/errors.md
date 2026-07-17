---
title: Error handling
description: "Throw typed errors anywhere; render them however you like with onError."
---

Errors are **thrown, not returned**. Throw a typed error anywhere in the pipeline — a provider, a step, or a handler — and green-tea converts it to a response at one place.

## The typed errors

All live in `@green-tea/core`:

| Throw | Status |
|---|---|
| `Unauthorized(msg?)` | `401` |
| `NotFound(msg?)` | `404` |
| `NotModified()` | `304` |
| `Redirect(location)` | `302` + `Location` |
| `ValidationError` | `422` (raised for you by schema validation) |
| `HttpError(status, msg?, body?)` | any status |
| anything else | `500` (message hidden — internals never leak) |

```typescript
@Step({ provides: 'user', needs: ['db', 'req'] })
class Authenticate {
  run(ctx) {
    const user = ctx.db.find(ctx.req.headers['x-token']);
    if (!user) throw new Unauthorized('invalid token'); // → 401, cuts the request
    return { user };
  }
}
```

By default an error becomes JSON: `{ "error": "<message>" }` (validation adds `source` + per-field `issues`).

## Structured error bodies

An `HttpError` can carry a **body** — return a structured payload instead of the default `{ error }`:

```typescript
throw new HttpError(409, 'conflict', { code: 'DUP_EMAIL', field: 'email' });
// → 409  { "code": "DUP_EMAIL", "field": "email" }
```

## Render errors your way — `onError`

Not everything should be JSON. Pass `onError` to `createApp` to render errors however you like — HTML, [RFC 7807](https://www.rfc-editor.org/rfc/rfc7807), content-negotiated, anything. It receives the error and the request, and returns a response — or `undefined` to fall back to the default JSON.

```typescript
import { isHttpError } from '@green-tea/core';

const app = createApp({
  modules: [ApiModule],
  onError(error, req) {
    const status = isHttpError(error) ? error.status : 500;
    // negotiate: HTML for browsers, JSON for API clients
    if (String(req.headers.accept).includes('text/html')) {
      return { status, headers: { 'content-type': 'text/html' }, body: `<h1>${status}</h1>` };
    }
    return undefined; // fall back to the default JSON
  },
});
```

`onError` intercepts **every** HTTP error response — handler/step throws, a `404` for an unmatched route, `405`, a `413` (body too large), and a `400` (malformed body) — so your error surface is consistent across the whole app. Streaming and WebSocket errors are out of scope (they surface as an error frame or a WebSocket close code, not a response body).

:::note
Errors are also observable without changing the response: subscribe to `request:step:error` (and `stream:error`) on [`app.bus`](/docs/guides/plugins/) to log or trace them.
:::
