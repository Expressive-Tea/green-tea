import type { App } from './app/types';
import { eventSocket, toWsRequest, upgradeSafely, type EventfulSocket } from './http/ws-adapter';
import { setProxyClient } from './http/peer';

// Minimal ambient for the Cloudflare Workers globals we use — avoids @cloudflare/workers-types.
// Declares only what we call; mirrors the real workerd signatures.
interface EdgeWebSocket extends EventfulSocket {
  accept(): void;
}
interface EdgeCtx {
  waitUntil(promise: Promise<unknown>): void;
}
declare const WebSocketPair: { new (): { 0: EdgeWebSocket; 1: EdgeWebSocket } };

/**
 * Cloudflare Workers / edge handler: HTTP + SSE via app.fetch, WebSocket via WebSocketPair.
 * Use as `export default { fetch: edgeHandler(app) }`. Requires the `nodejs_compat`
 * compatibility flag. The WS lifecycle runs on ctx.waitUntil so it survives past the 101 response.
 *
 * **Shutdown teardown never runs here, and nothing can make it.** Node, Deno and Bun all reach the
 * teardown registry through a `close()` that some object owns; workerd has no shutdown to intercept
 * — an isolate is discarded, not closed. A plugin or provider that relies on `onShutdown`/`dispose()`
 * to release something is therefore *silently* inert on the edge, which is why this says so rather
 * than a best-effort call on an event that does not exist. Anything that must be released belongs in
 * the request that acquired it, or in a platform binding that manages its own lifetime.
 */
export function edgeHandler(
  app: App,
): (request: Request, env?: unknown, ctx?: EdgeCtx) => Response | Promise<Response> {
  return (request, _env, ctx) => {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair()) as [EdgeWebSocket, EdgeWebSocket];
      server.accept();
      // No peer address on the edge, so `ip` starts empty; the header only fills it under `trustProxy`.
      const wsReq = toWsRequest(request, '');
      recordClient(wsReq, request);
      const lifecycle = upgradeSafely(app, wsReq, eventSocket(server));
      if (ctx?.waitUntil) ctx.waitUntil(lifecycle);
      else void lifecycle;

      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: EdgeWebSocket });
    }

    recordClient(request, request);
    return app.fetch(request);
  };
}

/**
 * Hands the app the `cf-connecting-ip` header for `source`, the object the app will be given for this
 * request. The app — not this adapter — decides whether it counts, since `trustProxy` is an app
 * option; HTTP and WebSocket both go through here and through the same check on the app side.
 * Without `trustProxy` the header is ignored and `ctx.ip` stays `''`: workerd exposes no peer address,
 * and an untrusted header is whatever the client chose to send.
 */
function recordClient(source: object, request: Request): void {
  setProxyClient(source, request.headers.get('cf-connecting-ip') ?? '');
}
