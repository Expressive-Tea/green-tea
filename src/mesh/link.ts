import type { Bus } from '../bus';
import { HttpError } from '../signals';
import { encode, decode, type Manifest, type RequestEnvelope, type Frame } from './protocol';

let connSeq = 0; // module-level: deterministic unique connection-id prefix (no Date.now/Math.random)

export interface Link {
  manifest: Manifest;
  rpc(kind: 'scope' | 'route', name: string, ctx: RequestEnvelope): Promise<unknown>;
  close(): void;
}

function loadWs(): any {
  return require('ws'); // lazy/optional, like streams; the ws CJS export is the WebSocket class
}

export function connectLink(args: {
  url: string;
  secret: string;
  timeoutMs?: number;
  bus?: Bus;
}): Promise<Link> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const WS = loadWs();
  const ws = new WS(args.url);
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let counter = 0;
  const connId = `c${connSeq++}`;
  let manifest: Manifest | undefined;

  return new Promise<Link>((resolve, reject) => {
    const connectTimer = setTimeout(() => {
      ws.close();
      reject(new Error(`mesh connect timeout: ${args.url}`));
    }, timeoutMs);

    ws.on('open', () => ws.send(encode({ type: 'hello', secret: args.secret })));
    ws.on('error', (e: unknown) => reject(e));
    ws.on('close', () => {
      clearTimeout(connectTimer);
      args.bus?.emit('mesh:disconnect', { name: args.url });
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('mesh link closed'));
      }
      pending.clear();
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
        manifest = { scopes: frame.scopes, routes: frame.routes };
        clearTimeout(connectTimer);
        args.bus?.emit('mesh:connect', { name: args.url });
        resolve({
          manifest,
          rpc(kind, name, ctx) {
            const id = `${connId}:${counter++}`;
            return new Promise((res, rej) => {
              const timer = setTimeout(() => {
                pending.delete(id);
                rej(new Error(`mesh rpc timeout: ${name}`));
              }, timeoutMs);
              pending.set(id, { resolve: res, reject: rej, timer });
              ws.send(encode({ type: 'rpc-req', id, kind, name, ctx }));
            });
          },
          close() {
            ws.close();
          },
        });
        return;
      }

      if (frame.type === 'rpc-res') {
        const p = pending.get(frame.id);
        if (!p) return;
        pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) {
          p.resolve(frame.result);
        } else {
          args.bus?.emit('mesh:rpc:error', { name: frame.id, error: frame.error });
          p.reject(new HttpError(frame.error.status ?? 500, frame.error.message));
        }
      }
    });
  });
}
