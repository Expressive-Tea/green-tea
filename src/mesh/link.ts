import type { Bus } from '../bus';
import { HttpError } from '../signals';
import { encode, decode, MESH_PROTOCOL_VERSION, type Manifest, type RequestEnvelope, type Frame } from './protocol';

/** Client handle to a remote mesh server: its manifest, an RPC caller, and a close(). */
export interface Link {
  manifest: Manifest;
  rpc(kind: 'scope' | 'route', name: string, ctx: RequestEnvelope): Promise<unknown>;
  close(): void;
}

/** An in-flight RPC awaiting its `rpc-res`, keyed by id in the pending map. */
type PendingEntry = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function loadWs(): any {
  // lazy/optional, like streams; the ws CJS export is the WebSocket class
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('ws');
}

/** Reject and clear every in-flight RPC — used when the link closes. */
function rejectAllPending(pending: Map<string, PendingEntry>, reason: string): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }

  pending.clear();
}

/** Register one RPC in `pending` by id, send its request, and reject it on timeout. */
function sendRpc(
  ws: any,
  pending: Map<string, PendingEntry>,
  id: string,
  kind: 'scope' | 'route',
  name: string,
  ctx: RequestEnvelope,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolveCall, rejectCall) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCall(new Error(`mesh rpc timeout: ${name}`));
    }, timeoutMs);

    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
    ws.send(encode({ type: 'rpc-req', id, kind, name, ctx }));
  });
}

/** Assemble the client-facing Link once the manifest arrives. */
function buildLink(ws: any, pending: Map<string, PendingEntry>, manifest: Manifest, timeoutMs: number): Link {
  // ids only need to be unique within this link: `pending` is per-connection, so a
  // per-link counter suffices (no module-global sequence, no test-order coupling).
  let counter = 0;

  return {
    manifest,
    rpc(kind, name, ctx) {
      const id = String(counter++);

      return sendRpc(ws, pending, id, kind, name, ctx, timeoutMs);
    },
    close() {
      ws.close();
    },
  };
}

/** Settle a pending RPC from its `rpc-res` frame — resolve on ok, reject (and emit) on error. */
function settleRpcResponse(
  pending: Map<string, PendingEntry>,
  frame: Extract<Frame, { type: 'rpc-res' }>,
  bus?: Bus,
): void {
  const entry = pending.get(frame.id);
  if (!entry) return;
  pending.delete(frame.id);
  clearTimeout(entry.timer);

  if (frame.ok) {
    entry.resolve(frame.result);
  } else {
    bus?.emit('mesh:rpc:error', { name: frame.id, error: frame.error });
    entry.reject(new HttpError(frame.error.status ?? 500, frame.error.message));
  }
}

/** Open a WebSocket link to a mesh server, handshake with `secret`, and resolve once its manifest arrives. */
export function connectLink(args: { url: string; secret: string; timeoutMs?: number; bus?: Bus }): Promise<Link> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const WS = loadWs();
  const ws = new WS(args.url);
  const pending = new Map<string, PendingEntry>();
  let manifest: Manifest | undefined;

  return new Promise<Link>((resolve, reject) => {
    const connectTimer = setTimeout(() => {
      ws.close();
      reject(new Error(`mesh connect timeout: ${args.url}`));
    }, timeoutMs);

    ws.on('open', () => ws.send(encode({ type: 'hello', v: MESH_PROTOCOL_VERSION, secret: args.secret })));
    ws.on('error', (error: unknown) => reject(error));
    ws.on('close', () => {
      clearTimeout(connectTimer);
      args.bus?.emit('mesh:disconnect', { name: args.url });
      rejectAllPending(pending, 'mesh link closed');
      if (!manifest) reject(new Error(`mesh handshake failed: ${args.url}`));
    });

    ws.on('message', (data: unknown) => {
      let frame: Frame;

      try {
        frame = decode(String(data));
      } catch {
        return;
      }

      if (frame.type === 'manifest') {
        clearTimeout(connectTimer);

        if (frame.v !== MESH_PROTOCOL_VERSION) {
          ws.close();
          reject(
            new Error(
              `mesh protocol version mismatch at ${args.url}: teapot speaks v${frame.v}, this teacup speaks v${MESH_PROTOCOL_VERSION}`,
            ),
          );
          return;
        }

        manifest = { scopes: frame.scopes, routes: frame.routes };
        args.bus?.emit('mesh:connect', { name: args.url });
        resolve(buildLink(ws, pending, manifest, timeoutMs));
        return;
      }

      if (frame.type === 'rpc-res') {
        settleRpcResponse(pending, frame, args.bus);
      }
    });
  });
}
