export interface StreamEncoder {
  headers: Record<string, string>;
  encode(item: unknown): string | Buffer;
  encodeError(err: unknown): string | Buffer | null;
  ping?(): string;
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const sseEncoder: StreamEncoder = {
  headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  encode: (item) => `data: ${JSON.stringify(item)}\n\n`,
  encodeError: (err) => `event: error\ndata: ${JSON.stringify({ error: msgOf(err) })}\n\n`,
  ping: () => ': ping\n\n',
};

export const ndjsonEncoder: StreamEncoder = {
  headers: { 'content-type': 'application/x-ndjson' },
  encode: (item) => `${JSON.stringify(item)}\n`,
  encodeError: (err) => `${JSON.stringify({ error: msgOf(err) })}\n`,
};
