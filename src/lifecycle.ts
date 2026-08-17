// src/lifecycle.ts — the teardown registry. Knows nothing about plugins, providers, apps or HTTP;
// the doors into it live where those things do.
import type { Logger } from './logger';

/**
 * Something to run before the app goes away.
 *
 * Takes no arguments on purpose. State lives in the closure that registered it — a provider's
 * `dispose()` already holds its own connection, and a plugin's callback already holds whatever the
 * plugin built. Nothing has to cross a scope, which is what makes this a registry rather than an
 * event bus: a bus solves "tell someone I do not know", and this is "run the thing I registered".
 */
export type TeardownFn = () => void | Promise<void>;

/**
 * Await-aware teardown, deliberately not the {@link Bus}.
 *
 * `Bus.on` takes a synchronous listener and `emit` swallows failures, both so that an observer can
 * never break the pipeline. A teardown needs the opposite of each: it must be awaited, and its
 * failure must be visible. Same word, opposite guarantees — see D1 of the design.
 *
 * Bounding is deliberately *not* here. `closeApp` and `closeWithDeadline` already implement a
 * deadline each, and a third implementation is how the three drift into different meanings of the
 * same `timeoutMs`.
 */
export class TeardownRegistry {
  private readonly callbacks: TeardownFn[] = [];
  private drained = false;

  /** Register `fn` to run on shutdown. Later registrations run first — see {@link run}. */
  add(fn: TeardownFn): void {
    this.callbacks.push(fn);
  }

  /** How many callbacks are registered; lets a caller skip the whole path when nothing wants it. */
  get size(): number {
    return this.callbacks.length;
  }

  /**
   * Run every callback, newest first, awaiting each.
   *
   * **Reverse registration order is load-bearing.** Providers register as they boot, and they boot
   * in topological order, so reversing registration is what gives dependants teardown before their
   * dependencies: a `cache` that needs `db` closes before the `db` it is still holding.
   *
   * Sequential rather than parallel, for the same reason — an order only means something if it is
   * waited on.
   *
   * A failing callback is reported and the next one still runs. One broken teardown must not strand
   * the rest or leave the process up. This mirrors `Bus`'s "a subscriber cannot break the system",
   * but with the visibility `Bus` lacks: `Bus` swallows silently because no logger existed when it
   * was written, and one exists now.
   *
   * Never throws, and never runs twice — `close()` is called twice by more real applications than
   * anyone expects, and a second call must not re-close what the first one closed.
   */
  async run(logger: Logger): Promise<void> {
    if (this.drained) return;
    this.drained = true;

    for (let index = this.callbacks.length - 1; index >= 0; index--) {
      try {
        await this.callbacks[index]();
      } catch (error) {
        logger.warn(`a shutdown teardown failed: ${(error as Error)?.message ?? String(error)}`, { error });
      }
    }
  }
}
