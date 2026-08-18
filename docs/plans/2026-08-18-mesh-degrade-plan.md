# A teapot that may be absent, declared per teapot

**Status:** planned, 2026-08-18
**Depends on:** the boot grace (`bootTimeoutMs`) and the reconnect/refuse work already merged
**Mesh stays alpha.**

## The decision

Strictness is a property of the *teapot*, not of the app. Diego: *"es mejor que los teapots definan
esa estrategia … 503 suena mejor para billing que para authorization."* A payment provider being
away is a degraded checkout; an authorization provider being away is not a degraded anything.

```ts
mesh: {
  teapots: [
    { url: billingUrl, secret, expects: ['billing'], onUnreachable: 'degrade' },
    { url: authUrl, secret },                                  // 'fail' — the default
  ],
}
```

## Why `expects` is required for `'degrade'`, and not inferred

A teapot that never answered never sent a manifest, so **we do not know what it exported**. Without
that list there is nothing to put in the graph, `@needs('billing')` has no provider, and graph
validation fails the boot anyway — degrading would fail identically, just later.

The tempting shortcut is to placeholder *every unresolved token*. That must not happen: it would
turn a misspelled `needs` into a runtime 503 instead of a boot error, and destroy the property the
framework leads with. `expects` keeps the placeholder set exact, so a typo anywhere else still fails
loudly.

It also pushes the developer to state what a service depends on, which is the same discipline the
graph asks for everywhere else. `createApp` throws when `'degrade'` is set without a non-empty
`expects`, naming the teapot.

## Decisions

**D1 — Placeholders are request-scope, never app-scope.** An app-scope placeholder resolves once at
boot, and throwing there is the very failure we are avoiding. A request-scope node runs per request
and throws `503`, naming the token and the teapot it belongs to.

**D2 — `expects` covers scope tokens only, not routes.** A degraded teapot's exported *routes*
simply do not exist locally, because a route needs a method and a pattern we were never told. A
request for one 404s, which is what an unregistered route does everywhere else. Documented, not
silent.

**D3 — Degraded tokens surface through `app.degraded()`**, the API that already reports optional
providers that failed to boot. A teapot that came up degraded is the same idea, not a parallel one,
and a consumer that already checks `degraded()` before reporting healthy gets this for free. Plus a
boot-time `logger.warn` and a `mesh:boot:degraded` event, for the same reason retries are both
logged and emitted.

**D4 — A degraded link keeps trying in the background.** Reconnection today only covers links that
handshook at least once; this one never did, so it needs its own attempt loop. Without it a degraded
teapot stays degraded until the process restarts, which is the bug this plan exists to avoid, moved.

**D5 — Adoption is the refuse rule again.** When a degraded teapot finally answers, its manifest
must contain everything in `expects`; if it does not, the connection is refused and the placeholders
stay. Same policy, same reason, and it reuses `missingFromManifest` with `expects` as the baseline
instead of a boot manifest.

**D6 — Swapping placeholders for real runners reuses the rebind seam** added for reconnection
(`invalidateRemoteBindings`). If that seam turns out not to fit, that is a signal the seam was
wrong, not a reason to write a second one.

## Tasks

1. `expects` and `onUnreachable` on the teapot entry; `createApp` throws for `'degrade'` without
   `expects`.
2. Placeholder step nodes per D1, registered when the boot grace runs out under `'degrade'`.
3. `degraded()` reporting per D3, plus the warn and the event.
4. Background attempt loop per D4, and adoption per D5/D6.
5. Tests, on all three server runtimes: boots degraded, the token 503s with a message naming it,
   the teapot arrives late and the same request then succeeds, a manifest missing `expects` is
   refused, and `'degrade'` without `expects` fails at `createApp`.
6. Docs: the mesh guide, `app.degraded()` in the reference, and the event table.

## Size

Comparable to the reconnection work — a background loop, a graph mutation and a runtime swap, on
three runtimes. Not a follow-up to squeeze into another change.
