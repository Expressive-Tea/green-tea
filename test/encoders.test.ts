import { describe, it, expect } from 'vitest';
import { sseEncoder, ndjsonEncoder } from '../src/encoders';

describe('sseEncoder', () => {
  it('frames data as SSE events', () => {
    expect(sseEncoder.encode({ a: 1 })).toBe('data: {"a":1}\n\n');
  });
  it('frames errors as an SSE error event with only the message', () => {
    expect(sseEncoder.encodeError(new Error('nope'))).toBe('event: error\ndata: {"error":"nope"}\n\n');
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
  it('frames errors as a terminal JSON line', () => {
    expect(ndjsonEncoder.encodeError(new Error('nope'))).toBe('{"error":"nope"}\n');
  });
  it('sets ndjson content-type and has no ping', () => {
    expect(ndjsonEncoder.headers['content-type']).toBe('application/x-ndjson');
    expect(ndjsonEncoder.ping).toBeUndefined();
  });
});
