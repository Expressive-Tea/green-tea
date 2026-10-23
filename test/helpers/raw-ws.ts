// A WebSocket client over a bare `node:net` socket, for the backpressure tests (#41) on Deno and
// Bun. The platform `WebSocket` reads as fast as it can and cannot be told to stop; a TCP socket
// can be paused, which is the "client reads slowly" those tests need. Server frames are unmasked,
// and every frame these tests send is the same size, so frames are found by offset alone.
import net from 'node:net';

export interface RawWs {
  /** Stop reading: the server's send buffer is all that can grow. */
  pause(): void;
  /** Resume reading; resolves once `count` frames have arrived, reporting whether they were in order. */
  readAll(count: number): Promise<{ received: number; inOrder: boolean }>;
  destroy(): void;
}

/**
 * Opens `ws://127.0.0.1:<port><path>` and resolves once the 101 is in. Each server frame must be
 * a text frame of exactly `payload` bytes (> 65535, so a 10-byte header) whose first 8 bytes are
 * its zero-padded index.
 */
export function rawWs(port: number, path: string, payload: number): Promise<RawWs> {
  const total = payload + 10;
  const socket = net.connect(port, '127.0.0.1');
  let head = '';
  let upgraded = false;
  let pos = 0;
  let digits = '';
  let received = 0;
  let inOrder = true;
  let onFrame = () => {};

  const consume = (chunk: Uint8Array) => {
    let i = 0;
    while (i < chunk.length) {
      if (pos < 18) {
        if (pos === 0 && chunk[i] !== 0x81) inOrder = false;
        if (pos >= 10) digits += String.fromCharCode(chunk[i]);
        if (pos === 17) {
          if (Number(digits) !== received) inOrder = false;
          digits = '';
        }
        pos++;
        i++;
      } else {
        const skip = Math.min(total - pos, chunk.length - i);
        pos += skip;
        i += skip;
      }
      if (pos === total) {
        pos = 0;
        received++;
        onFrame();
      }
    }
  };

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.on('data', (chunk: Uint8Array) => {
      if (upgraded) return consume(chunk);
      head += new TextDecoder('latin1').decode(chunk);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      upgraded = true;
      const rest = chunk.subarray(chunk.length - (head.length - end - 4));
      resolve({
        pause: () => socket.pause(),
        readAll: (count) =>
          new Promise((done) => {
            onFrame = () => {
              if (received === count) done({ received, inOrder });
            };
            socket.resume();
          }),
        destroy: () => socket.destroy(),
      });
      consume(rest);
    });
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
  });
}
