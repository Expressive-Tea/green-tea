import type { StreamEncoder } from '../encoders';

/** Wraps an AsyncIterable as a web ReadableStream, encoding each value. Cancels the source on stream cancel. */
export function asReadableStream(source: AsyncIterable<unknown>, encoder: StreamEncoder): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const te = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();

        if (done) {
          controller.close();
          return;
        }

        const encoded = encoder.encode(value);
        const bytes = typeof encoded === 'string' ? te.encode(encoded) : encoded;
        controller.enqueue(bytes);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
