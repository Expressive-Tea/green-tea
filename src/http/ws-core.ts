import { isHttpError } from '../signals';
import type { Bus } from '../bus';
import { matchPattern } from './router';
import type { WsRouteDef } from './types';

/** Neutral, runtime-free WebSocket request context (replaces the raw Node req). */
export interface WsRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  protocol: 'http' | 'https';
  ip: string;
}

/** Capability an adapter builds from its runtime socket. The neutral core talks only to this. */
export interface WsSocket {
  readonly inbound: AsyncIterable<unknown>;
  readonly abort: AbortSignal;
  readonly isOpen: boolean;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** Finds the first ws route whose pattern matches `path`, capturing its params. */
export function matchWsRoute(
  wsRoutes: WsRouteDef[],
  path: string,
): { def: WsRouteDef; params: Record<string, string> | undefined } | undefined {
  return wsRoutes
    .map((candidate) => ({ def: candidate, params: matchPattern(candidate.pattern, path) }))
    .find((entry) => entry.params);
}

/** Registers the connection with the stream registry so it can be force-closed on shutdown. */
function trackConnection(socket: WsSocket, streams?: Set<() => void>): { closer: () => void } {
  const closer = () => {
    try {
      socket.terminate();
    } catch {
      /* */
    }
  };

  streams?.add(closer);
  return { closer };
}

/** Drives the outbound async iterator, sending each yielded value until done or the socket closes. */
async function pumpOutbound(socket: WsSocket, iterator: AsyncIterator<unknown>): Promise<void> {
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    if (!socket.isOpen) break;
    socket.send(typeof value === 'string' ? value : JSON.stringify(value));
  }

  try {
    socket.close();
  } catch {
    /* already closed */
  }
}

/** Closes with 4000+status for HttpErrors, 1011 otherwise. */
function closeOnError(socket: WsSocket, err: unknown): void {
  if (isHttpError(err)) {
    const reason = Buffer.from(String(err.message)).subarray(0, 120).toString();

    try {
      socket.close(4000 + err.status, reason);
    } catch {
      /* already closed */
    }
  } else {
    try {
      socket.close(1011);
    } catch {
      /* already closed */
    }
  }
}

/** Runs the full per-connection lifecycle over a neutral socket capability. */
export async function runWsConnection(
  socket: WsSocket,
  request: WsRequest,
  route: { def: WsRouteDef; params: Record<string, string> | undefined },
  bus?: Bus,
  streams?: Set<() => void>,
): Promise<void> {
  const { closer } = trackConnection(socket, streams);
  const name = route.def.pattern;
  let iterator: AsyncIterator<unknown> | undefined;
  const cancelOutbound = () => void Promise.resolve(iterator?.return?.()).catch(() => {});
  socket.abort.addEventListener('abort', cancelOutbound, { once: true });
  bus?.emit('stream:open', { name });

  try {
    const outbound = await route.def.open({
      params: route.params ?? {},
      inbound: socket.inbound,
      abort: socket.abort,
      req: request,
    });
    iterator = outbound[Symbol.asyncIterator]();
    await pumpOutbound(socket, iterator);
  } catch (err) {
    bus?.emit('stream:error', { name, error: err });
    closeOnError(socket, err);
  } finally {
    streams?.delete(closer);
    bus?.emit('stream:close', { name });
  }
}
