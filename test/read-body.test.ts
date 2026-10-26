// readBody reads with listeners instead of `for await`; these pin the iterator's semantics it keeps.
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type http from 'node:http';
import { readBody } from '../src/http/request';

const request = (headers: Record<string, string> = {}) =>
  Object.assign(new PassThrough(), { headers }) as unknown as http.IncomingMessage & PassThrough;

describe('readBody', () => {
  it('joins every chunk, and answers undefined for an empty body', async () => {
    const req = request();
    const read = readBody(req, 100);
    req.write('ab');
    req.end('cd');
    expect((await read)?.toString()).toBe('abcd');

    const empty = request();
    const none = readBody(empty, 100);
    empty.end();
    expect(await none).toBeUndefined();
  });

  it('a body over the limit rejects 413 and destroys the request', async () => {
    const req = request();
    const read = readBody(req, 3);
    req.write('abcd');
    await expect(read).rejects.toMatchObject({ status: 413 });
    expect(req.destroyed).toBe(true);
  });

  it('a declared content-length over the limit rejects without reading', async () => {
    await expect(readBody(request({ 'content-length': '10' }), 3)).rejects.toMatchObject({ status: 413 });
  });

  it('a stream error or a close before end rejects', async () => {
    const failing = request();
    const read = readBody(failing, 100);
    failing.destroy(new Error('boom'));
    await expect(read).rejects.toThrow('boom');

    const closed = request();
    const cut = readBody(closed, 100);
    closed.write('ab');
    closed.destroy();
    await expect(cut).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' });
  });
});
