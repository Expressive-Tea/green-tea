import type http from 'http';
import { channel } from '../channel';
import type { Bus } from '../bus';
import { runWsConnection, matchWsRoute, trackUntil, type WsSocket, type WsRequest } from './ws-core';
import type { WsRouteDef, MeshControl } from './types';
import { normalizeRequestPath } from './router';
import { nodeRequire } from '../node-require';

/** Lazily loads the optional `ws` peer dependency's `WebSocketServer`, or null when it is not installed. */
function loadWss(): any | null {
  try {
    // `ws` is an OPTIONAL peer dependency: lazy-required so installs without WebSocket
    // support don't fail. When absent this throws and we fall back to null (501 on upgrade).
    return nodeRequire<{ WebSocketServer: unknown }>('ws').WebSocketServer;
  } catch {
    return null;
  }
}

/** Writes a bodyless HTTP status to the raw socket and destroys it. */
function rejectUpgrade(socket: any, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
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
    rejectUpgrade(socket, 501, 'Not Implemented');
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
    // A peer that resets mid-rejection must not raise an unhandled 'error' on a socket nobody
    // else is listening to yet: that is as fatal as a throw.
    socket.on('error', () => {});

    // Nothing thrown in here may escape. This is a raw EventEmitter listener, so a throw is an
    // uncaught exception that takes the whole process down, not a 500 for one client.
    try {
      routeUpgrade(wss, wsRoutes, req, socket, head, bus, meshControl, streams);
    } catch {
      if (socket.writable) rejectUpgrade(socket, 500, 'Internal Server Error');
      else socket.destroy();
    }
  });
}

/** Routes one upgrade: validates the path the way HTTP does, then mesh control, then the ws route table. */
function routeUpgrade(
  wss: any,
  wsRoutes: WsRouteDef[],
  req: http.IncomingMessage,
  socket: any,
  head: Buffer,
  bus?: Bus,
  meshControl?: MeshControl,
  streams?: Set<() => void>,
): void {
  let path: string;

  // The same normalization the HTTP path runs (`dispatch` in core.ts). Without it a malformed
  // escape reaches `decodeURIComponent` in the matcher and throws, and `//` silently matches.
  try {
    path = normalizeRequestPath((req.url ?? '/').split('?')[0]);
  } catch {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }

  if (meshControl && handleMeshUpgrade(wss, meshControl, path, req, socket, head, streams)) return;

  const route = matchWsRoute(wsRoutes, path);

  if (!route) {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }

  if (!wss) {
    rejectUpgrade(socket, 501, 'Not Implemented');
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: any) => {
    void runWsConnection(nodeSocket(ws), nodeWsRequest(req), route, bus, streams);
  });
}
