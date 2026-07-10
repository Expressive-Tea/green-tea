---
title: HTML & views
description: "The @Html decorator, the built-in template engine, and zero-config static file serving."
---

Most of green-tea assumes JSON, but not every route is an API endpoint. `@Html` marks a handler as serving HTML instead of going through the JSON transformer — a string, a file, or a file rendered with data. Add a static directory on top and you've got a small server-rendered site without reaching for a template framework.

## `@Html` — three modes

### 1. Return a string — every runtime

Bare `@Html` sends the handler's return value as `text/html; charset=utf-8`. No filesystem involved, so this mode runs on Node, Deno, Bun, and the edge.

```typescript
import { Route, Get, Html } from '@green-tea/core';

@Route('/')
class PageController {
  @Get('/')
  @Html
  home() {
    return '<h1>Hello from green-tea</h1>';
  }
}
```

### 2. Serve a file — Node/Deno/Bun

`@Html('file.html')` reads the file at boot, caches it, and serves it verbatim — the handler still runs (for side effects, guards, etc.) but its return value is ignored.

```typescript
@Route('/about')
class AboutController {
  @Get('/')
  @Html('about.html')
  about() {}
}
```

Reading a file needs a filesystem, so this mode is Node/Deno/Bun only — see [Runtimes](/guides/runtimes/) for the edge alternative.

### 3. Render a template — Node/Deno/Bun

`@Html('file.html', { template: true })` reads the file at boot and renders it with whatever object the handler returns, on every request.

```typescript
@Route('/user')
class UserController {
  @Get('/:id')
  @Html('user.html', { template: true })
  show(@param('id') id: string) {
    return { name: lookupName(id) };
  }
}
```

`user.html`:

```html
<h1>Hi {{ name }}</h1>
```

Same filesystem requirement as file mode: Node/Deno/Bun only.

:::caution[Return a string or data, never an `AsyncIterable`]
An `@Html` handler must return a string (bare mode) or a data object (template mode). Don't
return an `AsyncIterable` — the pipeline detects async-iterable returns and streams them raw,
bypassing the HTML transformer entirely, so your markup never gets wrapped or rendered.
:::

## The `views` base directory

`@Html('file.html')` paths resolve against `createApp({ views })` — a relative path joins `views`, an absolute path is used as-is (handy for a template stored outside the project, e.g. on an NFS mount). `views` defaults to `process.cwd()` when unset.

```typescript
const app = createApp({ modules: [ApiModule], views: 'templates' });
// @Html('about.html')            -> <cwd>/templates/about.html
// @Html('/srv/shared/about.html') -> /srv/shared/about.html (absolute, used as-is)
```

Files are read once, at boot — not on every request.

## The built-in template engine

Template mode renders with a small, dependency-free engine, also exported as `render` if you want to call it directly:

```typescript
import { render } from '@green-tea/core';

render('<h1>{{ name }}</h1>', { name: '<b>hi</b>' });
// '<h1>&lt;b&gt;hi&lt;/b&gt;</h1>'   — {{ x }} HTML-escapes

render('{{{ html }}}', { html: '<b>hi</b>' });
// '<b>hi</b>'                       — {{{ x }}} is raw, unescaped

render('{{ user.name }} / {{ nope }}', { user: { name: 'Diego' } });
// 'Diego / '                        — {{ a.b }} walks nested keys; a missing key renders empty
```

That's the whole engine: interpolation, escaped or raw, with dotted-key lookup. No loops, conditionals, or partials — reach for `viewEngine` below if you need those.

## Bring your own engine — `viewEngine`

`createApp({ viewEngine })` swaps in any `(source, data) => string` function for template mode — EJS, Handlebars, or your own:

```typescript
import ejs from 'ejs';

const app = createApp({
  modules: [ApiModule],
  views: 'templates',
  viewEngine: (source, data) => ejs.render(source, data as object),
});
```

`viewEngine` only affects `@Html(..., { template: true })`; string and plain file modes are unaffected.

## Static files — `createApp({ static })`

`static` serves a directory as a GET/HEAD fallback, tried after your declared routes and before a `404`:

```typescript
const app = createApp({ modules: [ApiModule], static: true });        // ./public, relative to cwd
const app2 = createApp({ modules: [ApiModule], static: 'assets' });   // ./assets, relative to cwd
const app3 = createApp({ modules: [ApiModule], static: '/srv/site' }); // absolute, used as-is
```

- Files are served at their URL path; content-type is inferred from the extension.
- `/` (and any directory-shaped path) resolves to `index.html`.
- Only `GET` and `HEAD` are handled — other methods fall through.
- **Declared routes always win.** Static is only consulted when nothing matched, so `@Get('/api/ping')` is never shadowed by a file at `public/api/ping`.
- Path traversal (`../`, encoded or not) is rejected — a request can't escape the static root.

Like the file/template modes of `@Html`, `static` needs a filesystem: it's Node/Deno/Bun only. Configuring it on an edge runtime throws at `createApp()` time — see [Runtimes](/guides/runtimes/).

## The boot rule

`@Html` only supports **buffered `GET`/`POST`** routes. Boot fails fast rather than misbehaving at request time:

```typescript
@Sse('/ticks')
@Html
ticks() { /* ... */ }
// throws at createApp(): "@Html on GET /ticks is not allowed —
// @Html only supports buffered GET/POST routes (not SSE/WS/PUT/PATCH/DELETE)"
```

`@Html` and `@Transformer` also can't be combined on the same handler — pick one:

```typescript
@Get('/g')
@Html
@Transformer(myTransformer)
g() { /* ... */ }
// throws at createApp(): "@Html and @Transformer on /g conflict — use one"
```

Both checks run once, at boot, alongside the rest of the route validation — never per-request.
