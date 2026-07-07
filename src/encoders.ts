/**
 * Serializes stream items into wire frames for a streaming transport (SSE, NDJSON).
 * `headers` is written once before the first frame; `ping` (if present) is sent periodically to keep the connection alive.
 */
export interface StreamEncoder {
  headers: Record<string, string>;
  encode(item: unknown): string | Buffer;
  encodeError(err: unknown): string | Buffer | null;
  ping?(): string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Server-Sent Events encoder: one JSON payload per `data:` event, with comment-line pings. */
export const sseEncoder: StreamEncoder = {
  headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  encode: (item) => `data: ${JSON.stringify(item)}\n\n`,
  encodeError: (err) => `event: error\ndata: ${JSON.stringify({ error: messageOf(err) })}\n\n`,
  ping: () => ': ping\n\n',
};

/** Newline-delimited JSON encoder: one JSON object per line. */
export const ndjsonEncoder: StreamEncoder = {
  headers: { 'content-type': 'application/x-ndjson' },
  encode: (item) => `${JSON.stringify(item)}\n`,
  encodeError: (err) => `${JSON.stringify({ error: messageOf(err) })}\n`,
};
