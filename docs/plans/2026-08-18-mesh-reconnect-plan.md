# Mesh reconnection, with a refusing manifest policy

**Status:** planned, 2026-08-18
**Scope:** `src/mesh/link.ts`, `src/app/index.ts`, `src/container.ts`, mesh tests, `guides/mesh.md`
**Mesh stays alpha.** It remains behind `experimental: true`. This closes the gap that makes mesh
unusable in production; it does not move the label, because the label is a statement about how much
we know, and we will know more once this runs somewhere real.

## The problem

There is no reconnection anywhere in `src/`. Combined with `spliceRemoteScopes` connecting teapots
serially and throwing on any failure (`src/app/index.ts:631`):

- a teapot down at boot → the teacup does not start;
- a teapot that dies afterwards → that link is dead for the life of the process, 503 on every RPC.

**Deploying a teapot therefore forces a restart of every teacup**, and boot order becomes
load-bearing. That is a worse operational property than any gap currently written in the docs.

## Vocabulary

**Reconnect** is returning to the *same* teapot when it comes back. **Failover** — switching to a
different teapot exporting the same thing — needs load balancing and stays out of scope. The two
words must not be used interchangeably in code, CHANGELOG or docs.

## Decisions

**D1 — The `Link` object must survive the reconnect.** `buildRemote` captures `link.rpc` into the
registry's runners at boot, and the graph holds those closures. A reconnect that produced a new
`Link` would leave the graph pointing at the dead one. So `Link` owns a *swappable* socket, and
`connectLink` becomes "establish, then keep established".

**D2 — Reconnection covers links that handshook at least once.** A boot-time failure still fails
boot, unchanged. Boot retry is a separate piece of work; mixing them would blur "this app cannot be
configured" with "this dependency is temporarily away".

**D3 — Exponential backoff with jitter**, 500 ms initial, 30 s cap, timer `unref`'d — matching the
heartbeat, so reconnection never holds a process open on its own.

**D4 — The refuse rule.** On reconnect, the new manifest must still contain **everything this link
contributed at boot**: every scope token, with the same `app`/`request` lifetime, and every route by
method plus *effective shape* (the same comparison `spliceRemoteScopes` already uses for ambiguity,
so `/:id` and `/:name` are the same shape). Anything missing → refuse the connection.

Rationale: the graph was validated at boot against the old manifest and is already running. A token
that vanished cannot be validated away after the fact, and serving requests against a manifest that
no longer backs the graph is how you get a 500 that looks like application code.

**D5 — Extra exports in a returned manifest are ignored.** The graph is fixed at boot; new tokens are
not spliced in. Documented, not silent.

**D6 — A refused reconnect keeps retrying, but logs once per distinct manifest fingerprint.** A
rollback can restore the missing token, so giving up permanently would turn a recoverable state into
an outage. Logging every attempt at the 30 s cap would be 2,880 identical lines a day.

**D7 — The policy is a named strategy from day one**: `mesh: { onManifestChange: 'refuse' }`, and
`'refuse'` is the default. Reconciliation is a future version and lands as `'reconcile'`, additively.
If refusal shipped as implicit behaviour instead, adding reconciliation later would change the
meaning of an existing default across processes on separate deploy cadences — breaking, in the worst
place to be breaking.

**D8 — App-scope invalidation is lazy, and re-registers rather than clears.** A remote app-scope
provider is resolved once at boot and frozen into the container as `() => value`
(`src/app/index.ts:744`). Invalidation re-registers the binding with a factory that re-runs the RPC
and resets `resolved`, so the *next* resolve pays for it. Eager re-resolution would put a network
call on the reconnect path, where its failure has nowhere to go. This closes the documented
"app-scope export survives its teapot with a stale value" gap.

The invalidation is written as **"invalidate the remote bindings of link X"**, a named function, not
inline in the reconnect handler — that function is what reconciliation will reuse.

**D9 — `close()` is terminal.** `closeLinks` runs on shutdown; a link closed by the application must
never reconnect. This is the trap worth naming: without it, `app.close()` leaves a process that
cannot exit.

**D10 — RPCs during the down window are unchanged**: immediate 503 from the existing `isOpen` guard,
not a wait for `timeoutMs`.

## Tasks

1. **`Link` owns its socket.** Extract the handshake into something callable more than once; `Link`
   holds `current: WsSocket | undefined`, and `rpc` reads it. `isOpen` false → the existing 503.
2. **Reconnect loop** on `abort`, unless closed by D9. Backoff per D3, `mesh:disconnect` on drop and
   `mesh:connect` on success (existing events; no new bus contract in alpha).
3. **Manifest comparison.** Capture the contributed set at boot, compare per D4, reuse
   `compilePattern(...).shape` for routes. Refusal logs the missing token or route by name.
4. **`invalidateRemoteBindings(link)`** per D8, called on successful reconnect.
5. **Config**: `mesh: { reconnect?: boolean | { initialDelayMs?, maxDelayMs? }, onManifestChange?: 'refuse' }`.
   Reconnect defaults **on**. Validate at boot like the other mesh options.
6. **Tests.** Reconnect after the teapot returns; refuse when a token disappears, with the message
   naming it; `close()` stops reconnection (assert no timer keeps the process alive); an app-scope
   value re-resolves after reconnect; a heartbeat-triggered close reconnects. Deno and Bun get the
   reconnect case — the platform `WebSocket` is a different client implementation, which is exactly
   where a swappable socket can break.
7. **Docs.** `guides/mesh.md`: mesh stays alpha, the gap list loses the stale-value entry and gains
   "extra exports are not spliced". CHANGELOG under `Fixed`, because from the operator's side this is
   a defect, not a feature.

## Not in this plan

Boot retry, correlation across the mesh (and the `mesh:rpc:error` name/id bug), the teapot handshake
deadline, the frame size cap, `req.url` in the envelope. All queued, none blocked by this.
