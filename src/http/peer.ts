// src/http/peer.ts — the socket peer address, handed from the Deno and Bun adapters to `buildFetch`.
// Internal: not exported from the package.
//
// Keyed by the `Request` object rather than carried on it. A header would be visible to handlers and
// spoofable by any client that sent one with the same name; a second `fetch` parameter would be
// public API. The adapters call `app.fetch` with the very object they record, so identity holds, and
// the entry goes when the request does. A `Request` copied from it carries nothing, which is what a
// bare `app.fetch` from user code has always seen.
//
// The map lives on `globalThis` under a registered symbol, not in this module, because this module
// is not always one instance. The CommonJS build bundles `index`, `deno` and `bun` as separate files
// with no shared chunk, so each carries its own copy of this one: a module-private map in
// `@green-tea/core/bun` would record peers that `app.fetch` from `@green-tea/core` never sees. An app
// that loads core both as ESM and as CommonJS has the same split.
//
// Bun records its server rather than an address. `server.requestIP()` is a native call that builds
// an object, and making it on every request measured 7–11% on Bun; recording the server is free, and
// the address is asked for only when something reads `ctx.ip`. Deno hands the address over already
// resolved, so it records the string.
const KEY = Symbol.for('@green-tea/core:peer');

/** Names a request's socket peer on demand: Bun's server. */
export interface PeerSource {
  requestIP(request: Request): { address: string } | null;
}

const registry = globalThis as { [KEY]?: WeakMap<Request, string | PeerSource> };
const peers = (registry[KEY] ??= new WeakMap<Request, string | PeerSource>());

/** Records the peer of `request`. An empty address — a unix socket has none — is not recorded. */
export function setPeer(request: Request, peer: string | PeerSource): void {
  if (peer) peers.set(request, peer);
}

/** The peer an adapter recorded for `request`, or `''` when none did. */
export function peerOf(request: Request): string {
  const peer = peers.get(request);
  return typeof peer === 'object' ? (peer.requestIP(request)?.address ?? '') : (peer ?? '');
}

// The client address a runtime adapter read from a header its platform's proxy sets — today only the
// edge adapter, from `cf-connecting-ip`. Unlike the socket peer above, a header is client-supplied
// unless a proxy in front overwrites it, so it only counts under `trustProxy`; the adapter cannot
// decide that, because the option lives on the app, so it records the value and the app decides.
// Keyed by the `Request` (HTTP) or the `WsRequest` (WebSocket upgrade) the adapter hands the app, for
// the same reasons as the peer: no handler-visible header, no extra public parameter. Same
// `globalThis` registration, because `@green-tea/core/edge` is a separate bundle too.
const PROXY_KEY = Symbol.for('@green-tea/core:proxy-client');
const proxyRegistry = globalThis as { [PROXY_KEY]?: WeakMap<object, string> };
const proxyClients = (proxyRegistry[PROXY_KEY] ??= new WeakMap<object, string>());

/** Records `ip` as the client address a proxy header named for `source`. An empty value is not recorded. */
export function setProxyClient(source: object, ip: string): void {
  if (ip) proxyClients.set(source, ip);
}

/**
 * The client address an adapter recorded for `source` from a proxy header, when `trustProxy` is on;
 * `''` otherwise. The one check both `app.fetch` and `app.upgrade` run, so HTTP and WebSocket cannot
 * disagree about whether the header counts.
 */
export function trustedProxyClient(source: object, trustProxy: boolean | undefined): string {
  return trustProxy ? (proxyClients.get(source) ?? '') : '';
}
