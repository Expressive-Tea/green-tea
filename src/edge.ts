import type { App } from './app/types';
import { eventSocket, toWsRequest, upgradeSafely, type EventfulSocket } from './http/ws-adapter';

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
      const wsReq = toWsRequest(request, request.headers.get('cf-connecting-ip') ?? '');
      const lifecycle = upgradeSafely(app, wsReq, eventSocket(server));
      if (ctx?.waitUntil) ctx.waitUntil(lifecycle);
      else void lifecycle;

      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: EdgeWebSocket });
    }

    return app.fetch(request);
  };
}
