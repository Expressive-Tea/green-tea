import type http from 'http';
import { HttpError } from '../signals';
import { declaresOverLimit } from './body';

/** Reads the full request body, enforcing the max-bytes ceiling (throws 413 if exceeded). */
export function readBody(req: http.IncomingMessage, maxBodyBytes: number): Promise<Buffer | undefined> {
  // A declared length over the limit is refused without waiting for the first chunk, which could
  // otherwise sit until the request timeout. The fetch adapter makes the same check.
  const contentLength = req.headers['content-length'];
  if (declaresOverLimit(contentLength, maxBodyBytes)) return Promise.reject(new HttpError(413, 'Payload Too Large'));

  // No `Transfer-Encoding` and no (or a zero) `Content-Length` is a request without a body (RFC 9112
  // §6.3) — every GET. Node's parser has already finished it, so there is nothing to wait for, and
  // subscribing to the stream anyway measured ~4% on an 8 KB GET response. Node drains the unread
  // request itself when the response ends.
  if (req.headers['transfer-encoding'] === undefined && (contentLength === undefined || contentLength === '0'))
    return Promise.resolve(undefined);

  // Listeners rather than `for await`: the async iterator costs a promise and a microtask per chunk,
  // which a JSON POST pays on every request. The semantics are the iterator's: the running total
  // still enforces the limit, an over-limit body destroys the request as leaving the loop did, and a
  // stream that errors or closes before `end` rejects.
  return new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const settle = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };

    const onData = (chunk: Buffer): void => {
      total += chunk.length;

      if (total <= maxBodyBytes) {
        chunks.push(chunk);
        return;
      }

      settle();
      req.destroy();
      reject(new HttpError(413, 'Payload Too Large'));
    };

    const onEnd = (): void => {
      settle();
      resolve(chunks.length === 0 ? undefined : chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
    };

    const onError = (err: Error): void => {
      settle();
      reject(err);
    };

    const onClose = (): void => {
      settle();
      reject(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/** Returns the first comma-separated token of a header value (handles array-valued headers). */
function firstToken(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(',')[0].trim();
}

/** Determines whether the request arrived over HTTPS, honoring `x-forwarded-proto` when proxy is trusted. */
export function deriveSecure(req: http.IncomingMessage, trustProxy: boolean): boolean {
  if (trustProxy) {
    const proto = firstToken(req.headers['x-forwarded-proto']);
    if (proto) return proto === 'https';
  }

  return (req.socket as any).encrypted === true;
}

/** Resolves the client IP, honoring `x-forwarded-for` when proxy is trusted. */
export function deriveIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstToken(req.headers['x-forwarded-for']);
    if (forwarded) return forwarded;
  }

  return req.socket.remoteAddress ?? '';
}
