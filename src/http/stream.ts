import type http from 'http';
import { once } from 'events';
import { sseEncoder, ndjsonEncoder, StreamEncoder } from '../encoders';
import type { Transport } from '../metadata';
import type { Bus } from '../bus';

const PING_MS = 15_000;

/** Selects the stream encoder for a transport, falling back to the client's `Accept` header for `stream`. */
export function pickEncoder(transport: Transport, accept: string): StreamEncoder {
  if (transport === 'sse') return sseEncoder;
  if (transport === 'ndjson') return ndjsonEncoder;
  return accept.includes('text/event-stream') ? sseEncoder : ndjsonEncoder;
}

/** Pipes an async-iterable result to the response as an HTTP stream, with keep-alive pings and backpressure handling. */
export async function pipeStream(
  res: http.ServerResponse,
  stream: AsyncIterable<unknown>,
  encoder: StreamEncoder,
  bus?: Bus,
  name = '',
  streams?: Set<() => void>,
): Promise<void> {
  res.writeHead(200, encoder.headers);
  res.flushHeaders(); // establish the stream immediately so idle-until-event sources (e.g. subscriptions) don't deadlock clients awaiting headers
  bus?.emit('stream:open', { name });
  const iterator = stream[Symbol.asyncIterator]();
  let ping: ReturnType<typeof setInterval> | undefined;

  if (encoder.ping) {
    ping = setInterval(() => res.write(encoder.ping!()), PING_MS);
    ping.unref?.();
  }

  const stop = () => {
    if (ping) clearInterval(ping);
    void Promise.resolve(iterator.return?.()).catch(() => {});
  };

  res.on('close', stop);

  const closer = () => {
    try {
      res.destroy();
    } catch {
      /* */
    }
  };

  streams?.add(closer);
  const onClose = once(res, 'close');

  try {
    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;

      if (!res.write(encoder.encode(value))) {
        await Promise.race([once(res, 'drain'), onClose]);
        if (res.destroyed) break; // let finally clean up
      }
    }
  } catch (err) {
    bus?.emit('stream:error', { name, error: err });
    const frame = encoder.encodeError(err);
    if (frame && !res.writableEnded) res.write(frame);
  } finally {
    if (ping) clearInterval(ping);
    streams?.delete(closer);
    if (!res.writableEnded && !res.destroyed) res.end();
    bus?.emit('stream:close', { name });
  }
}
