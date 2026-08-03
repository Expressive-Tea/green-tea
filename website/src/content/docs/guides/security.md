---
title: Transport security
description: "TLS and wss, secure-by-default headers, CORS, and trustProxy."
---

Four `createApp` options cover TLS, proxying, CORS, and response headers: `tls`,
`trustProxy`, `cors`, and `security`. See the [`createApp` reference](/docs/reference/createapp/)
for the full option list.

## TLS (native https/wss)

```typescript
import { readFileSync } from 'fs';

const app = createApp({
  modules: [App],
  tls: { key: readFileSync('key.pem'), cert: readFileSync('cert.pem') },
});
```

When `tls` is set the server serves https, and WebSocket upgrades become wss on the same
port — no other changes.

## `trustProxy`

```typescript
const app = createApp({ modules: [App], trustProxy: true });
```

Behind a reverse proxy, reads `X-Forwarded-Proto` / `X-Forwarded-For` to populate
`ctx.protocol` (`'http' | 'https'`) and `ctx.ip` (read via `@ctx()`). Off by default —
forwarded headers are ignored (and spoofable) until you opt in. It trusts the immediate hop
unconditionally; there's no CIDR allowlist yet.

## CORS

Off unless `origins` is set.

```typescript
const app = createApp({
  modules: [App],
  cors: { origins: 'https://app.example.com', credentials: true },
});
```

`origins` accepts `string | string[] | '*' | (origin) => boolean`. A preflight `OPTIONS`
request (with `Access-Control-Request-Method`) is auto-answered with 204 before explicit or
automatic OPTIONS routing. A bare OPTIONS request is instead handled by an explicit `@Options`
route or the router's automatic `204` + `Allow` response.

- With `credentials: true`, the server **never** sends `Access-Control-Allow-Origin: *` — it
  echoes the concrete allowed origin (or blocks the request).

:::caution[Reflect-any foot-gun]
`origins: '*'` together with `credentials: true` reflects *any* origin with credentials
attached. Only combine them if you truly intend an open credentialed API; prefer an explicit
allowlist.
:::

## `security` (headers, ON by default)

Applied to every HTTP response. Disable everything with `security: false`, or override
individual headers with an options object.

| Header | Default |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Referrer-Policy` | `no-referrer` |
| `X-DNS-Prefetch-Control` | `off` |
| `Strict-Transport-Security` | `max-age=15552000` (180d) — **only when the connection is secure** (native TLS, or `trustProxy` + `X-Forwarded-Proto: https`); no `includeSubDomains`/`preload` |
| `Content-Security-Policy` | not set — pass `security: { csp: "..." }` |

```typescript
const app = createApp({ modules: [App], security: { csp: "default-src 'self'" } });
```

:::note[Scope caveat]
`security` and `cors` headers apply to HTTP responses; they do **not** apply to the
WebSocket handshake (101/upgrade) response.
:::

:::caution[TLS + trustProxy]
HSTS is emitted only when the connection is judged secure. With `trustProxy: true` that
judgement trusts the incoming `X-Forwarded-Proto` header — so a client that spoofs
`X-Forwarded-Proto: http` past a permissive proxy can make the server treat the request as
insecure and **suppress the HSTS header**. Only enable `trustProxy` behind a proxy that
strips and sets forwarded headers itself, and terminate TLS where you control that hop.
:::

## Defaults

| Option | Default |
|---|---|
| `tls` | off (plain http/ws) |
| `trustProxy` | off |
| `cors` | off (same-origin only) |
| `security` | ON (HSTS only when the connection is secure) |

## Related

- [`createApp` reference](/docs/reference/createapp/) — every construction option
- [File uploads / multipart](/docs/guides/uploads/) — request-body handling
