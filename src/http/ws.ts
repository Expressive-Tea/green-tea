import type http from 'http';
import { channel } from '../channel';
import type { Bus } from '../bus';
import { runWsConnection, matchWsRoute, trackUntil, type WsSocket, type WsRequest } from './ws-core';
import type { WsRouteDef, MeshControl } from './types';

/** Lazily loads the optional `ws` peer dependency's `WebSocketServer`, or null when it is not installed. */
function loadWss(): any | null {
  try {
    // `ws` is an OPTIONAL peer dependency: lazy-required so installs without WebSocket
    // support don't fail. When absent this throws and we fall back to null (501 on upgrade).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ws').WebSocketServer;
  } catch {
    return null;
  }
}

/** Writes a 501 Not Implemented status to the raw socket and destroys it. */
function reject501(socket: any): void {
  socket.write('HTTP/1.1 501 Not Implemented\r\n\r\n');
  socket.destroy();
}

/** Handles the mesh-control upgrade path; returns true when the request was for the mesh control endpoint. */
function handleMeshUpgrade(
  wss: any,
  meshControl: MeshControl,
  path: string,
  req: http.IncomingMessage,
  socket: any,
  head: Buffer,
  streams?: Set<() => void>,
): boolean {
  if (path !== meshControl.path) return false;

  if (!wss) {
    reject501(socket);
    return true;
  }

  // nodeSocket, not the raw ws: the control channel is the last consumer that spoke the
  // `ws` EventEmitter API directly. It now takes the same neutral socket every route does.
  // Tracked like any other long-lived socket: a connected teacup has no reason to hang up, so
  // an untracked control channel leaves the teapot's server.close() waiting on it forever.
  // serveFrames swallows its own failures, so the floating promise cannot reject.
  wss.handleUpgrade(req, socket, head, (ws: any) => {
    const neutral = nodeSocket(ws);

    void trackUntil(neutral, meshControl.handle(neutral), streams);
  });
  return true;
}

/** Builds the neutral WsRequest from a Node upgrade request. Same values the old open() read from req.socket. */
function nodeWsRequest(req: http.IncomingMessage): WsRequest {
  return {
    url: req.url ?? '/',
    headers: req.headers,
    protocol: (req.socket as any).encrypted ? 'https' : 'http',
    ip: req.socket.remoteAddress ?? '',
  };
}

/** Wraps a `ws` socket as a neutral WsSocket: inbound channel + abort on close + send/close/terminate. */
function nodeSocket(ws: any): WsSocket {
  const inbound = channel<unknown>();
  const ac = new AbortController();
  ws.on('message', (data: Buffer) => inbound.push(data.toString()));
  ws.on('close', () => {
    inbound.close();
    ac.abort();
  });
  ws.on('error', (err: unknown) => inbound.fail(err));
  return {
    inbound,
    abort: ac.signal,
    get isOpen() {
      return ws.readyState === 1; // 1 = OPEN
    },
    send: (data) => ws.send(data),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    },
    terminate: () => (ws.terminate ?? ws.close).call(ws),
  };
}

/** Attaches WebSocket upgrade handling to the server: routes to `wsRoutes` or a mesh control path. */
export function attachWs(
  server: http.Server,
  wsRoutes: WsRouteDef[],
  bus?: Bus,
  meshControl?: MeshControl,
  streams?: Set<() => void>,
): void {
  if (wsRoutes.length === 0 && !meshControl) return;
  const WebSocketServer = loadWss();
  const wss = WebSocketServer ? new WebSocketServer({ noServer: true }) : null;
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0];

    if (meshControl && handleMeshUpgrade(wss, meshControl, path, req, socket, head, streams)) return;

    const route = matchWsRoute(wsRoutes, path);

    if (!route) {
      socket.destroy();
      return;
    }

    if (!wss) {
      reject501(socket);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: any) => {
      void runWsConnection(nodeSocket(ws), nodeWsRequest(req), route, bus, streams);
    });
  });
}
