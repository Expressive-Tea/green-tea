# Changelog

All notable changes to `@green-tea/core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
green-tea uses calendar versioning: `YY.MM.PATCH`.

## [Unreleased]

Beta on the road to a release candidate. No published release yet; the
version below is a placeholder until the API freeze.

### Added
- **Transport security** — native TLS termination (https/wss), CORS with a
  guarded preflight and credentials-safe origins, secure-by-default response
  headers (nosniff, X-Frame-Options, Referrer-Policy, HSTS-when-secure), and
  proxy-aware `trustProxy` exposing `ctx.protocol` / `ctx.ip`.
- **Input validation** — `@body/@query/@param/@headers` accept any
  [Standard Schema](https://standardschema.dev) (zod / valibot / arktype); the
  parsed value is passed to the handler, invalid input returns `422` with
  per-field issues. Core stays dependency-free.
- **Body parsing** — JSON, `application/x-www-form-urlencoded`, and
  `multipart/form-data` file uploads (`@body()` → `{ fields, files }`), with a
  configurable repeated-field policy (`bodyDuplicates`, per-route overridable)
  and a `maxParts` DoS bound.
- **Streams** — SSE / ndjson / WebSocket duplex over a multicast
  `AsyncIterable` channel, with backpressure and cleanup; `rooms` broadcast hubs.
- **Graph introspection** — `app.explain(route)`, `app.graph()`,
  `app.toMermaid()` / `toDOT()`, and an opt-in `GET /__graph__` dev endpoint.
- **Operational hardening** — request body/size limits (`413`), request and
  keep-alive timeouts, and `app.close()` graceful shutdown (drains in-flight
  requests, closes live streams and mesh links).
- **Testing ergonomics** — `createApp({ overrides })` swaps any provider/step
  by token in one line.
- **Mesh (walking skeleton)** — `teapot`/`teacup` distributed dependency
  injection over a secret-gated WebSocket control channel. Experimental.
- **Benchmarks** — reproducible `npm run bench` harness vs Express 5, Fastify 5,
  NestJS, and raw `http`; results in [BENCHMARKS.md](./BENCHMARKS.md).

[Unreleased]: https://git.svc.zoit.services/Green-Tea/core/commits/develop
