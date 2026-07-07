---
title: File uploads
description: "multipart parsing via the optional busboy peer dependency."
---

A request with `Content-Type: multipart/form-data` makes `@body()` resolve to `{ fields, files }` instead of a plain object.

:::caution[multipart needs the optional `busboy` peer]
Multipart parsing uses the optional [`busboy`](https://github.com/mscdex/busboy) peer dependency — install it with `npm i busboy`. A `multipart/form-data` request to a server without busboy installed returns **`501`**. (JSON and urlencoded need nothing extra.)
:::

```typescript
import { Route, Post, body } from '@green-tea/core';
import type { MultipartBody } from '@green-tea/core';

@Route('/profile')
class ProfileController {
  @Post('/avatar')
  upload(@body() form: MultipartBody) {
    const name = form.fields.name;         // string | string[]
    const avatar = form.files.avatar;      // UploadedFile | UploadedFile[]
    return { name, size: Array.isArray(avatar) ? undefined : avatar?.size };
  }
}
```

`UploadedFile` is `{ filename, contentType, data: Buffer, size }` — the whole file is buffered in memory, no temp files.

:::note[Access asymmetry]
For multipart, `@body('title')` returns `undefined` — the value lives at `body.fields.title`, not `body.title`, unlike JSON/urlencoded where `@body('title')` picks the value directly. Use `@body()` and read `.fields`/`.files`, or key into the envelope itself with `@body('fields')` / `@body('files')`. See [arguments](/guides/arguments/) for how `@body()` behaves across content types.
:::

## Repeated fields — `bodyDuplicates`

By default, a repeated field name keeps the **last** value (`'last'`, matching urlencoded). Set `bodyDuplicates: 'array'` on `createApp` to accumulate repeats into a `string[]` instead — this applies to **both** urlencoded and multipart text fields:

```typescript
const app = createApp({ modules: [ApiModule], bodyDuplicates: 'array' });
```

Files under a repeated field name always become an array (`UploadedFile[]`), regardless of `bodyDuplicates`.

## Per-endpoint override

```typescript
@Post('/upload', { duplicates: 'array' })
upload(@body() form: MultipartBody) { /* ... */ }
```

Precedence: route `duplicates` → app `bodyDuplicates` → `'last'`.

## Limits

Uploaded files are held in memory, so they're bounded by the same `maxBodyBytes` limit as any other request body (over the limit → **413**). `maxParts` (default `1000`) caps the number of multipart parts per request:

```typescript
const app = createApp({ modules: [ApiModule], limits: { maxParts: 500 } });
```

A malformed multipart body (bad boundary, missing headers, truncated part) → **400**.

:::note
To validate parsed fields against a schema, pass a Standard Schema to `@body()` — see [validation](/guides/validation/).
:::
