/**
 * Bounds a graceful shutdown by a deadline, forcing whatever is left.
 *
 * Shared by the Deno and Bun adapters so the two cannot drift into different meanings of the same
 * `timeoutMs`, and shaped like the Node path in `closeApp`: try to drain, and if the deadline
 * passes first, force the remainder and resolve anyway.
 *
 * The race is the point, and it is not paranoia. Both runtimes' force calls were measured against
 * a handler that never resolves and returned immediately, but `Bun.stop(true)` was also measured
 * waiting out a handler with a pending timer — same call, ~2s, because it awaits pending async
 * work rather than only open connections. Awaiting the force call would therefore inherit exactly
 * the unbounded wait the deadline exists to prevent. Resolving on our own timer means `close()`
 * returns within `timeoutMs` whatever either runtime decides to wait for.
 *
 * @param graceful Drain in flight work. Unbounded — that is what the deadline is for.
 * @param force Stop waiting and drop what is left. Fire-and-forget; its promise is not awaited.
 */
export function closeWithDeadline(
  graceful: () => Promise<void>,
  force: () => void,
  timeoutMs: number,
  onTimeout?: (timeoutMs: number) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    // Armed before `finish` exists, and deliberately: setTimeout cannot invoke its callback
    // synchronously, so `finish` is always assigned by the time this can reach it. The reverse
    // ordering would rest on when the runtime's own promise settles. Mirrors `closeApp`.
    const timer = setTimeout(() => {
      if (settled) return;
      onTimeout?.(timeoutMs);
      force();
      finish();
    }, timeoutMs);

    timer.unref?.();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    // A graceful path that rejects still has to end the shutdown: the deadline covers a slow
    // close, not a broken one, and leaving close() pending forever is the worse failure.
    void graceful().then(finish, finish);
  });
}
