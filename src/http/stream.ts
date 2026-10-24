import type http from 'http';
import { once } from 'events';
import { sseEncoder, ndjsonEncoder, StreamEncoder } from '../encoders';
import type { Transport } from '../metadata';
import type { Bus, Correlation } from '../bus';
import type { NeutralOutcome } from './core';
import { frameSink } from './compression';
import { releaseIterator } from '../channel';

const PING_MS = 15_000;

/**
 * Stream encoder per transport, or `null` for transports that never produce an HTTP stream.
 * A new transport must add a row — the compiler fails until it does, so it can't silently
 * inherit ndjson framing.
 */
const STREAM_ENCODERS: Record<Transport, ((accept: string) => StreamEncoder) | null> = {
  buffer: null, // a buffered handler returning a stream throws TransportMismatchError before reaching here
  ws: null, // not an HTTP response; ws routes are served via upgrade, not handle()
  sse: () => sseEncoder,
  ndjson: () => ndjsonEncoder,
  negotiate: (accept) => (accept.includes('text/event-stream') ? sseEncoder : ndjsonEncoder),
};

/** Selects the stream encoder for a transport, falling back to the client's `Accept` header for `negotiate`. */
export function pickEncoder(transport: Transport, accept: string): StreamEncoder {
  const pick = STREAM_ENCODERS[transport];
  if (!pick) throw new Error(`transport '${transport}' does not produce an HTTP stream`);

  return pick(accept);
}

/**
 * Pipes a stream outcome to the response, with keep-alive pings and backpressure handling. With
 * `outcome.encoding` set (CARD-16), frames go through a `node:zlib` stream piped into `res`, flushed
 * after every frame, error frame and ping, so each event is decodable on arrival.
 */
export async function pipeStream(
  res: http.ServerResponse,
  outcome: Extract<NeutralOutcome, { kind: 'stream' }>,
  bus?: Bus,
  streams?: Set<() => void>,
  correlation: Correlation = {},
): Promise<void> {
  const { stream, encoder, route: name } = outcome;
  // `route` duplicates `name` here rather than being passed separately: on a stream event `name`
  // is always the route pattern, never the concrete path the request events can carry — but a
  // consumer following the documented contract labels on `route` and would otherwise find it
  // absent on the longest-lived thing the server does. See `EventPayload.name`.
  const trace = { name, route: name, ...correlation };
  res.writeHead(200, outcome.headers);
  res.flushHeaders(); // establish the stream immediately so idle-until-event sources (e.g. subscriptions) don't deadlock clients awaiting headers
  bus?.emit('stream:open', trace);
  const sink = frameSink(res, outcome.encoding);
  const iterator = stream[Symbol.asyncIterator]();
  let ping: ReturnType<typeof setInterval> | undefined;

  if (encoder.ping) {
    ping = setInterval(() => sink.write(encoder.ping!()), PING_MS);
    ping.unref?.();
  }

  const stop = () => {
    if (ping) clearInterval(ping);
    // A client gone mid-stream: the compressor holds zlib memory outside the JS heap until destroyed.
    sink.destroy();
    releaseIterator(iterator);
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
  // `next()` is raced against the disconnect (GitHub #40): an idle source's may never settle, and
  // waiting on it kept this loop and its closer alive long after the client had gone.
  const gone = onClose.then(() => undefined);

  try {
    while (true) {
      const step = await Promise.race([iterator.next(), gone]);
      if (!step || step.done) break;
      const { value } = step;

      if (!sink.write(encoder.encode(value))) {
        await Promise.race([once(sink.drains, 'drain'), onClose]);
        if (res.destroyed) break; // let finally clean up
      }
    }
  } catch (err) {
    bus?.emit('stream:error', { ...trace, error: err });
    const frame = encoder.encodeError(err);
    if (frame && !res.writableEnded) sink.write(frame);
  } finally {
    if (ping) clearInterval(ping);
    streams?.delete(closer);
    if (!res.writableEnded && !res.destroyed) sink.end();
    bus?.emit('stream:close', trace);
  }
}
