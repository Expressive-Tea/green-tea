import { channel } from './channel';
import type { App } from './app/types';
import type { WsSocket, WsRequest } from './http/ws-core';

// Minimal ambient for the Cloudflare Workers globals we use — avoids @cloudflare/workers-types.
// Declares only what we call; mirrors the real workerd signatures.
interface EdgeWebSocket {
  accept(): void;
  addEventListener(
    type: 'message' | 'close' | 'error',
    listener: (event: { data?: string | ArrayBuffer }) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}
interface EdgeCtx {
  waitUntil(promise: Promise<unknown>): void;
}
declare const WebSocketPair: { new (): { 0: EdgeWebSocket; 1: EdgeWebSocket } };

const decoder = new TextDecoder();

/** Builds a neutral WsRequest from a Cloudflare Worker request. */
function toWsRequest(request: Request): WsRequest {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    url: url.pathname + url.search,
    headers,
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    ip: request.headers.get('cf-connecting-ip') ?? '',
  };
}

/** Wraps a Cloudflare server-side WebSocket (already accept()ed) as a neutral WsSocket. */
function edgeSocket(server: EdgeWebSocket): WsSocket {
  const inbound = channel();
  const ac = new AbortController();
  server.addEventListener('message', (event) => {
    const data = event.data;
    inbound.push(typeof data === 'string' ? data : decoder.decode(data as ArrayBuffer));
  });
  server.addEventListener('close', () => {
    inbound.close();
    ac.abort();
  });
  server.addEventListener('error', () => {
    inbound.fail(new Error('websocket error'));
    ac.abort();
  });
  return {
    inbound,
    abort: ac.signal,
    get isOpen() {
      return server.readyState === 1; // 1 = OPEN
    },
    send: (data) => {
      server.send(data);
    },
    close: (code, reason) => {
      try {
        server.close(code, reason);
      } catch {
        /* already closed */
      }
    },
    terminate: () => {
      try {
        server.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Cloudflare Workers / edge handler: HTTP + SSE via app.fetch, WebSocket via WebSocketPair.
 * Use as `export default { fetch: edgeHandler(app) }`. Requires the `nodejs_compat`
 * compatibility flag. The WS lifecycle runs on ctx.waitUntil so it survives past the 101 response.
 */
export function edgeHandler(
  app: App,
): (request: Request, env?: unknown, ctx?: EdgeCtx) => Response | Promise<Response> {
  return (request, _env, ctx) => {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair()) as [EdgeWebSocket, EdgeWebSocket];
      server.accept();
      const lifecycle = app.upgrade(toWsRequest(request), edgeSocket(server)).catch(() => {
        try {
          server.close(1011, 'internal error');
        } catch {
          /* already closed */
        }
      });
      if (ctx?.waitUntil) ctx.waitUntil(lifecycle);
      else void lifecycle;

      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: EdgeWebSocket });
    }

    return app.fetch(request);
  };
}
