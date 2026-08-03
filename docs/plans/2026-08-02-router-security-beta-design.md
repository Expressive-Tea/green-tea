# Router correctness and security beta design

**Date:** 2026-08-02
**Target:** `26.8.0-beta.0`
**Status:** Approved

## Goal

Prepare the August beta by completing the router's missing HTTP behavior, adding safe segment constraints, aligning the public documentation with the code, and removing known dependency vulnerabilities from the core repository and documentation site.

The release keeps the current linear matcher. A radix tree remains a separate performance project that must earn its complexity through benchmarks.

## Scope

This change includes:

- first-class `HEAD` and `OPTIONS` routes;
- automatic `HEAD` fallback to `GET`;
- automatic bare `OPTIONS` responses;
- correct and deterministic `Allow` headers;
- a tolerant trailing-slash policy with rejection of repeated internal slashes;
- route-pattern validation at boot;
- safe parameter constraints such as `:id(\d+)`;
- malformed URI handling as a client error;
- duplicate and ambiguous route detection;
- OpenAPI projection of constrained parameters;
- dependency remediation for the root package and `website/`;
- public documentation and changelog updates;
- the `26.8.0-beta.0` package-version bump.

This change excludes:

- a radix-tree matcher;
- arbitrary, unrestricted regular expressions;
- manual publication, npm tags, or registry mutations;
- mesh discovery, load balancing, and failover.

## Route semantics

### Path normalization

`/users` and `/users/` identify the same route. The matcher removes one trailing slash except for `/`.

The ingress rejects repeated slashes, including `/users//42`, with `400 Bad Request`. It applies this rule before declared-route matching and static-file fallback, so Node and Fetch adapters behave alike.

Malformed percent encoding also returns `400 Bad Request`. A malformed path never escapes the matcher as `URIError` and never becomes `500`.

### Methods

The public `HttpMethod` type and decorator surface gain `HEAD` and `OPTIONS`. `@Head` and `@Options` accept the same route options as the existing buffered method decorators.

For `HEAD`, an explicit `HEAD` route wins. Without one, the router matches the corresponding `GET` route and executes its pipeline, but every adapter suppresses the response body. The response retains the status and headers that `GET` would produce. Streaming routes do not serve as implicit `HEAD` handlers.

For a bare `OPTIONS` request, an explicit `OPTIONS` route wins. Without one, any matching path receives `204 No Content` and an `Allow` header. CORS preflight remains the earlier specialized branch and keeps its configured CORS response.

`Allow` uses a stable method order. It adds `HEAD` when a buffered `GET` route exists and adds `OPTIONS` whenever the path exists. A request with another unsupported method receives `405` plus the same value.

### Pattern validation

The application compiles and validates route patterns during graph construction. Invalid declarations fail before the app serves traffic. Validation rejects:

- a catch-all outside the final segment;
- empty parameter or catch-all names;
- repeated parameter names in one pattern;
- repeated internal slashes in declarations;
- malformed constraints;
- duplicate routes with the same method and effective pattern;
- patterns that differ only by parameter names and therefore match the same requests with equal precedence.

Errors name the method, pattern, controller origin, and conflict when applicable.

### Segment constraints

The matcher accepts a constrained parameter such as `:id(\d+)`. A constraint matches the whole decoded segment. `/users/12` matches `:id(\d+)`; `/users/12x` does not. A failed constraint remains a normal non-match, so another route may win before the router returns `404`.

The implementation compiles constraints once and caches the compiled pattern. It accepts a deliberately small regular-expression subset for common numeric, UUID, slug, and enumerated segments. It rejects lookarounds, backreferences, nested groups, nested quantifiers, and other constructs that create a practical ReDoS risk. This keeps the advertised syntax without executing unrestricted attacker-facing regular expressions.

Specificity remains deterministic:

1. static segment;
2. constrained parameter;
3. unconstrained parameter;
4. catch-all.

Registration order resolves only genuine, non-ambiguous ties that survive boot validation.

## Architecture

`src/http/router.ts` owns pattern parsing, validation, compilation, matching, method fallback, and `Allow` calculation. A compiled representation records normalized segments, parameter names, optional constraints, catch-all state, and specificity.

`src/metadata.ts` exposes the new method type and decorators. Application graph construction compiles route definitions and reports declaration errors with controller context. The runtime-neutral HTTP core decides `HEAD`, `OPTIONS`, `400`, `404`, and `405`; Node and Fetch adapters only serialize its outcome.

`src/openapi.ts` converts constrained paths to OpenAPI templates and places the accepted expression in the path parameter's `schema.pattern`. It lists explicit `HEAD` and `OPTIONS` operations but does not invent operations for automatic fallbacks.

Mesh route manifests carry the expanded method union. Existing wire behavior stays compatible because method values are strings and the change adds values without changing the envelope shape.

## Error behavior

Declaration errors fail at boot. Request syntax errors return the standard error envelope with status `400` and pass through the configured `onError` renderer. Pattern non-matches return `404`; method mismatches return `405`; automatic `OPTIONS` returns `204`.

Error responses keep the existing security and CORS header injection. They do not include decoded attacker input, stack traces, or internal regular-expression details.

## Dependency remediation

The published runtime dependency set is already clean: `npm audit --omit=dev` reports zero vulnerabilities. The full development tree and documentation site require remediation.

The root update will prefer the smallest supported versions that close each advisory:

- Vitest moves to `3.2.6`, which fixes the critical advisory while preserving Node 18 support;
- the Nest benchmark packages move to `11.1.28`, including Multer `2.2.0`;
- Miniflare moves to its current compatible patch with fixed Sharp;
- Fastify and compatible toolchain packages receive current patch/minor updates;
- `find-my-way` receives a narrow `9.7.0` override while Nest pins the vulnerable `9.6.0`, with Nest/Fastify benchmarks as a compatibility gate;
- Autocannon's `hyperid`/`uuid` chain receives an isolated remediation only if the benchmark suite proves it compatible; otherwise the benchmark dependency will be replaced or isolated rather than suppressing the advisory.

The documentation site moves Astro to `7.1.6`, Starlight to `0.41.6`, and resolves the patched PostCSS and SVGO versions. Both lockfiles will be regenerated from their manifests.

The work will not use `npm audit fix --force`, security-audit suppression, or an incompatible downgrade merely to produce a green report.

## Documentation

The change updates:

- the README routing section and roadmap;
- the Routing guide;
- the Decorators reference;
- the OpenAPI guide where constrained parameters affect output;
- the CHANGELOG and package version;
- the Starlight 404 configuration that currently emits a build warning.

Examples will state the trailing-slash policy, double-slash rejection, automatic method behavior, constraint limits, and the deferred radix-tree work.

## Verification

The implementation adds unit and integration coverage for:

- explicit and implicit `HEAD`;
- body suppression and header preservation;
- explicit and automatic `OPTIONS`;
- CORS-preflight precedence;
- deterministic `Allow` values;
- trailing slash equivalence and double-slash rejection;
- invalid percent encoding;
- route-declaration failures;
- constrained matches, non-matches, precedence, and unsafe-expression rejection;
- OpenAPI path and `schema.pattern` output;
- Node and Fetch parity;
- mesh method serialization where relevant.

The release gate runs:

- root and website audits with zero known vulnerabilities;
- the runtime-only root audit separately;
- Node tests, typecheck, lint, format, complexity, and build;
- Deno, Bun, and Edge suites when their runtimes are available;
- documentation build without the current 404 warning;
- framework benchmarks, including the Nest/Fastify paths affected by overrides;
- `npm pack --dry-run` to inspect the published artifact.

## CI and publication flow

Gitea remains the source of the release flow:

1. CI runs on `develop` and `main`.
2. A merge to Gitea `main` publishes the package to internal Verdaccio under `stg`.
3. Gitea's promotion workflow pushes only `main` and version tags to GitHub.
4. A promoted `v*` tag triggers GitHub's `release.yml`.
5. GitHub publishes to npm through Trusted Publishing/OIDC and derives `beta` from `26.8.0-beta.0`.

This implementation prepares the version and validates the workflows. It does not merge to `main`, create a release tag, publish to Verdaccio, or invoke `npm publish` locally.
