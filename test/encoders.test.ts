import { describe, it, expect } from 'vitest';
import { sseEncoder, ndjsonEncoder } from '../src/encoders';
import { HttpError } from '../src/signals';

describe('sseEncoder', () => {
  it('frames data as SSE events', () => {
    expect(sseEncoder.encode({ a: 1 })).toBe('data: {"a":1}\n\n');
  });
  it('frames an HttpError as an SSE error event with only its message', () => {
    expect(sseEncoder.encodeError(new HttpError(409, 'nope'))).toBe('event: error\ndata: {"error":"nope"}\n\n');
  });
  it('masks any other error, like a buffered 500 (GHSA-235j-fx64-w9p9)', () => {
    expect(sseEncoder.encodeError(new Error('db password=hunter2'))).toBe(
      'event: error\ndata: {"error":"Internal Server Error"}\n\n',
    );
  });
  it('sets text/event-stream headers and has a ping', () => {
    expect(sseEncoder.headers['content-type']).toBe('text/event-stream');
    expect(typeof sseEncoder.ping).toBe('function');
    expect(sseEncoder.ping!()).toBe(': ping\n\n');
  });
});

describe('ndjsonEncoder', () => {
  it('frames one JSON line per item', () => {
    expect(ndjsonEncoder.encode({ a: 1 })).toBe('{"a":1}\n');
  });
  it('frames an HttpError as a terminal JSON line', () => {
    expect(ndjsonEncoder.encodeError(new HttpError(409, 'nope'))).toBe('{"error":"nope"}\n');
  });
  it('masks any other error (GHSA-235j-fx64-w9p9)', () => {
    expect(ndjsonEncoder.encodeError(new Error('db password=hunter2'))).toBe('{"error":"Internal Server Error"}\n');
  });
  it('sets ndjson content-type and has no ping', () => {
    expect(ndjsonEncoder.headers['content-type']).toBe('application/x-ndjson');
    expect(ndjsonEncoder.ping).toBeUndefined();
  });
});
