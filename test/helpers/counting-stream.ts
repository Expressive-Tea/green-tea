// A request body that records how much of it was consumed. Web APIs only, so the Node, Deno and Bun
// suites share it: the regression it guards (#105) is "read the whole body before checking the
// limit", which no status code can show on its own — a 413 looks the same either way.

export interface CountingStream {
  stream: ReadableStream<Uint8Array>;
  /** Chunks the consumer has pulled so far. */
  readonly pulled: number;
  /** Whether the consumer cancelled the stream. */
  readonly cancelled: boolean;
}

/** `count` chunks of `size` bytes each, handed out one per pull. */
export function countingStream(count: number, size: number): CountingStream {
  let pulled = 0;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    // Pull-based, and only on demand: with a high-water mark of 0 the stream does not pre-fill its
    // queue, so `pulled` counts what the consumer asked for. The default of 1 pulls a chunk at
    // construction, before anyone reads, and would make "nothing was read" unprovable.
    pull(controller) {
      if (pulled === count) {
        controller.close();
        return;
      }
      pulled++;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });

  return {
    stream,
    get pulled() {
      return pulled;
    },
    get cancelled() {
      return cancelled;
    },
  };
}
