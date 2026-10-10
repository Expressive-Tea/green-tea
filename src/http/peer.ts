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
const KEY = Symbol.for('@green-tea/core:peer');
const registry = globalThis as { [KEY]?: WeakMap<Request, string> };
const peers = (registry[KEY] ??= new WeakMap<Request, string>());

/** Records `ip` as the peer of `request`. An empty address — a unix socket has none — is not recorded. */
export function setPeer(request: Request, ip: string): void {
  if (ip) peers.set(request, ip);
}

/** The peer an adapter recorded for `request`, or `''` when none did. */
export function peerOf(request: Request): string {
  return peers.get(request) ?? '';
}
