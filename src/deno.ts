import { channel } from './channel';
import type { App } from './app/types';
import type { WsSocket, WsRequest } from './http/ws-core';

// The project tsconfig's `lib` doesn't include `DOM`, and the installed `@types/node` (18.x)
// doesn't declare a global `WebSocket` either — so we ambient-declare just the shape we use
// (both the instance interface and the `OPEN` static, mirroring the real WebSocket).
interface WebSocketEventMap {
  message: { data: string | ArrayBuffer };
  close: object;
  error: object;
}
interface WebSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void): void;
}
declare const WebSocket: { readonly OPEN: number };

// Minimal ambient for the Deno globals we use — avoids a @types/deno devDep.
// Mirrors the real Deno.serve / Deno.upgradeWebSocket signatures we call.
interface DenoServeOptions {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (addr: { hostname: string; port: number }) => void;
}
interface DenoServeHandlerInfo {
  remoteAddr: { hostname: string; port: number; transport: string };
}
interface DenoHttpServer {
  finished: Promise<void>;
  shutdown(): Promise<void>;
}
type DenoServeHandler = (request: Request, info: DenoServeHandlerInfo) => Response | Promise<Response>;
declare const Deno: {
  serve(options: DenoServeOptions, handler: DenoServeHandler): DenoHttpServer;
  upgradeWebSocket(request: Request): { socket: WebSocket; response: Response };
};

/** Builds a neutral WsRequest from a Deno upgrade Request + connection info. */
function toWsRequest(request: Request, info: DenoServeHandlerInfo): WsRequest {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    url: url.pathname + url.search,
    headers,
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    ip: info.remoteAddr.hostname,
  };
}

/** Wraps a Deno/web WebSocket as a neutral WsSocket. */
function denoSocket(ws: WebSocket): WsSocket {
  const inbound = channel<unknown>();
  const ac = new AbortController();
  ws.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();
  ws.addEventListener('message', (e) => {
    const data = e.data;
    inbound.push(typeof data === 'string' ? data : decoder.decode(data as ArrayBuffer));
  });
  ws.addEventListener('close', () => {
    inbound.close();
    ac.abort();
  });
  ws.addEventListener('error', () => {
    inbound.fail(new Error('websocket error'));
    ac.abort();
  });
  return {
    inbound,
    abort: ac.signal,
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send: (data) => ws.send(data),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    },
    terminate: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Serve a Green Tea app on Deno: HTTP + SSE via app.fetch, WebSocket via Deno.upgradeWebSocket.
 * WebSocket messages flow through app.upgrade over the shared neutral core.
 */
export function serveDeno(app: App, options?: DenoServeOptions): DenoHttpServer {
  return Deno.serve(options ?? {}, (request, info) => {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const { socket, response } = Deno.upgradeWebSocket(request);
      // Fire-and-forget: the upgrade response must be returned synchronously while
      // the graph runs. app.upgrade can reject BEFORE runWsConnection's own try/catch
      // (mesh-before-listen throw, or a provider boot failure), so guard the call here —
      // an uncaught rejection would be fatal on Deno and crash the whole server.
      void app.upgrade(toWsRequest(request, info), denoSocket(socket)).catch(() => {
        try {
          socket.close(1011, 'internal error');
        } catch {
          /* already closed */
        }
      });
      return response;
    }

    return app.fetch(request);
  });
}
