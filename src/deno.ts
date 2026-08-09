import type { App } from './app/types';
import { eventSocket, toWsRequest, upgradeSafely, type EventfulSocket } from './http/ws-adapter';

// The project tsconfig's `lib` doesn't include `DOM`, and the installed `@types/node` (18.x)
// doesn't declare a global `WebSocket` either — so we ambient-declare just the shape we use.
interface WebSocket extends EventfulSocket {
  binaryType: string;
}

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

/**
 * Serve a Green Tea app on Deno: HTTP + SSE via app.fetch, WebSocket via Deno.upgradeWebSocket.
 * WebSocket messages flow through app.upgrade over the shared neutral core.
 * Deno.serve exposes no equivalent to Node's server.maxConnections; enforce connection caps at
 * the deployment platform or reverse proxy.
 */
export function serveDeno(app: App, options?: DenoServeOptions): DenoHttpServer {
  return Deno.serve(options ?? {}, (request, info) => {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      // Deno invalidates request connection metadata as soon as the upgrade is accepted.
      const wsRequest = toWsRequest(request, info.remoteAddr.hostname);
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.binaryType = 'arraybuffer'; // deliver binary frames as ArrayBuffer, which decodeMessage expects
      // fire-and-forget: the 101 response must be returned synchronously while the graph runs
      void upgradeSafely(app, wsRequest, eventSocket(socket));
      return response;
    }

    return app.fetch(request);
  });
}
