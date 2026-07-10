import type http from 'http';
import { HttpError } from '../signals';

/** Reads the full request body, enforcing the max-bytes ceiling (throws 413 if exceeded). */
export async function readBody(req: http.IncomingMessage, maxBodyBytes: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBodyBytes) throw new HttpError(413, 'Payload Too Large');
    chunks.push(chunk as Buffer);
  }

  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
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
