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

// Registered globally rather than module-local: this package ships twice — a bundle on npm and raw
// source on JSR — so two copies in one dependency tree is a real shape, and a marker that stopped
// being recognised across them would silently degrade back to an id-less `data:` frame.
const SSE_EVENT = Symbol.for('green-tea.sse-event');

/** Optional SSE fields carried alongside a payload. See {@link sse}. */
export interface SseFields {
  /**
   * The event's id, written as `id:`. The browser echoes the last one it saw back as the
   * `Last-Event-ID` request header when `EventSource` reconnects — read it with
   * `@header('last-event-id')` and resume from there.
   */
  id?: string;
  /** Event name, written as `event:`. Dispatched to `addEventListener(name)` instead of `onmessage`. */
  event?: string;
  /** Reconnection delay in whole milliseconds, written as `retry:`. Applies to the connection, not the event. */
  retry?: number;
}

/** A stream item carrying SSE fields as well as a payload. Build one with {@link sse}. */
export interface SseEvent<T = unknown> extends SseFields {
  readonly [SSE_EVENT]: true;
  data: T;
}

/** Type guard: true when a stream item was built by {@link sse}. */
export function isSseEvent(item: unknown): item is SseEvent {
  return typeof item === 'object' && item !== null && (item as Record<symbol, unknown>)[SSE_EVENT] === true;
}

// The SSE wire format is line-based, so a newline inside a field value ends the field — and a
// value that reaches `id:` from a request (a cursor, a page token) would let a caller append
// arbitrary fields, or whole events, to somebody else's stream. Rejected rather than stripped:
// a silently-shortened id is echoed back as `Last-Event-ID` and resumes from the wrong place,
// which is the same invisible gap this feature exists to close. `pipeStream` catches this, emits
// `stream:error` and writes an `error` frame, so the failure is loud and lands on the first event.
function assertFieldSafe(field: string, value: string): void {
  if (!/[\r\n\0]/.test(value)) return;

  throw new Error(
    `sse(): '${field}' may not contain a newline or a NUL — the SSE wire format is line-based, so ` +
      'one would end the field and let the rest of the value be read as further SSE fields. ' +
      `Received ${JSON.stringify(value)}.`,
  );
}

/**
 * Tags a stream item with SSE fields, so an `@Sse` route can emit `id:`, `event:` and `retry:`
 * instead of a bare `data:` frame.
 *
 * The `id` is what makes an `EventSource` reconnect resumable: the browser sends the last id it
 * saw back as `Last-Event-ID`, and the handler decides what to do with it. green-tea carries the
 * marker in both directions and stores nothing — a source that can resume, resumes; one that
 * cannot keeps streaming from now, which is the honest behaviour for a live feed.
 *
 * On an `ndjson` or `negotiate`-to-ndjson route the payload is unwrapped and the SSE fields are
 * dropped, because NDJSON has no frame to carry them and no resumption protocol to use them.
 *
 * @example
 * ```ts
 * @Sse('/feed')
 * feed(@header('last-event-id') from: string) {
 *   return (async function* () {
 *     for await (const row of rows({ after: from })) yield sse(row, { id: row.seq });
 *   })();
 * }
 * ```
 */
export function sse<T>(data: T, fields: SseFields = {}): SseEvent<T> {
  if (fields.id !== undefined) assertFieldSafe('id', fields.id);
  if (fields.event !== undefined) assertFieldSafe('event', fields.event);

  // Browsers ignore a `retry:` that is not a base-10 integer, so a float would silently leave the
  // reconnection delay at the default rather than at the value the app asked for.
  if (fields.retry !== undefined && !Number.isInteger(fields.retry)) {
    throw new Error(`sse(): 'retry' must be a whole number of milliseconds, received ${fields.retry}.`);
  }

  return { [SSE_EVENT]: true, data, ...fields };
}

/**
 * Frames one item as an SSE event. Fields precede `data:` and `data:` closes the event.
 * `JSON.stringify` escapes newlines inside the payload, so the data line is single by construction.
 */
function sseFrame(item: unknown): string {
  if (!isSseEvent(item)) return `data: ${JSON.stringify(item)}\n\n`;
  let frame = '';

  if (item.retry !== undefined) frame += `retry: ${item.retry}\n`;
  if (item.event !== undefined) frame += `event: ${item.event}\n`;
  if (item.id !== undefined) frame += `id: ${item.id}\n`;

  return `${frame}data: ${JSON.stringify(item.data)}\n\n`;
}

/** Server-Sent Events encoder: one JSON payload per `data:` event, with comment-line pings. */
export const sseEncoder: StreamEncoder = {
  headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
  encode: sseFrame,
  encodeError: (err) => `event: error\ndata: ${JSON.stringify({ error: messageOf(err) })}\n\n`,
  ping: () => ': ping\n\n',
};

/** Newline-delimited JSON encoder: one JSON object per line. */
export const ndjsonEncoder: StreamEncoder = {
  headers: { 'content-type': 'application/x-ndjson' },
  // Unwrapped rather than serialized as-is: a `negotiate` route yields the same items to both
  // encoders, and an ndjson client asked for the payload, not green-tea's SSE envelope around it.
  encode: (item) => `${JSON.stringify(isSseEvent(item) ? item.data : item)}\n`,
  encodeError: (err) => `${JSON.stringify({ error: messageOf(err) })}\n`,
};
