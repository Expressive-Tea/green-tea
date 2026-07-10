import { channel } from './channel';
import type { Channel } from './channel';
import type { App } from './app/types';
import type { WsSocket, WsRequest } from './http/ws-core';

// Minimal ambient for the Bun globals we use — avoids a @types/bun devDep.
// Mirrors the real Bun.serve / server.upgrade / ServerWebSocket signatures we call.
interface BunServerWebSocket {
  data: unknown;
  readyState: number;
  send(data: string): number;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}
interface BunWebSocketHandler {
  open?(ws: BunServerWebSocket): void;
  message(ws: BunServerWebSocket, message: string | Uint8Array): void;
  close?(ws: BunServerWebSocket, code: number, reason: string): void;
}
interface BunServer {
  port: number;
  stop(closeActiveConnections?: boolean): void;
  upgrade(request: Request, options?: { data?: unknown; headers?: Record<string, string> }): boolean;
  requestIP(request: Request): { address: string; family: string; port: number } | null;
}
interface BunServeOptions {
  port?: number;
  hostname?: string;
  fetch(request: Request, server: BunServer): Response | Promise<Response> | undefined;
  websocket?: BunWebSocketHandler;
}
type BunServeShortOptions = { port?: number; hostname?: string };
declare const Bun: { serve(options: BunServeOptions): BunServer };

/** Per-connection state stashed on ws.data between fetch (upgrade) and the open/message/close callbacks. */
interface BunConnData {
  wsReq: WsRequest;
  inbound: Channel<unknown>;
  ac: AbortController;
}

/** Builds a neutral WsRequest from a Bun request + server (for the client IP). */
function toWsRequest(request: Request, server: BunServer): WsRequest {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    url: url.pathname + url.search,
    headers,
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    ip: server.requestIP(request)?.address ?? '',
  };
}

/** Wraps a Bun ServerWebSocket (+ its stashed channel/abort) as a neutral WsSocket. */
function bunSocket(ws: BunServerWebSocket): WsSocket {
  const { inbound, ac } = ws.data as BunConnData;
  return {
    inbound,
    abort: ac.signal,
    get isOpen() {
      return ws.readyState === 1; // 1 = OPEN
    },
    send: (data) => {
      ws.send(data);
    },
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    },
    terminate: () => {
      try {
        (ws.terminate ?? ws.close).call(ws);
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Serve a Green Tea app on Bun: HTTP + SSE via app.fetch, WebSocket via Bun's server-level
 * websocket handler. The ServerWebSocket only exists in open(), so per-connection state
 * (inbound channel, abort, WsRequest) is stashed on ws.data during the upgrade.
 */
export function serveBun(app: App, options?: BunServeShortOptions): BunServer {
  return Bun.serve({
    ...options,
    fetch(request, server) {
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const inbound = channel();
        const ac = new AbortController();
        const data: BunConnData = { wsReq: toWsRequest(request, server), inbound, ac };
        if (server.upgrade(request, { data })) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      return app.fetch(request);
    },
    websocket: {
      open(ws) {
        const { wsReq } = ws.data as BunConnData;
        // fire-and-forget: app.upgrade can reject before runWsConnection's try/catch
        // (mesh-before-listen, provider boot failure); guard it or an uncaught rejection
        // could crash the Bun process.
        void app.upgrade(wsReq, bunSocket(ws)).catch(() => {
          try {
            ws.close(1011, 'internal error');
          } catch {
            /* already closed */
          }
        });
      },
      message(ws, message) {
        const { inbound } = ws.data as BunConnData;
        // decode binary to UTF-8 to match Node's Buffer.toString() (cross-adapter parity)
        inbound.push(typeof message === 'string' ? message : new TextDecoder().decode(message));
      },
      close(ws) {
        const { inbound, ac } = ws.data as BunConnData;
        inbound.close();
        ac.abort();
      },
    },
  });
}
