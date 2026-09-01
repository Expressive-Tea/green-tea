// src/http/signals-shutdown.ts — SIGINT/SIGTERM → close(), opt-in, one spelling per runtime.

import type { Logger } from '../logger';

/** The two signals an orchestrator actually sends: Ctrl-C, and every container runtime's stop. */
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;

type Signal = (typeof SIGNALS)[number];

interface SignalApi {
  runtime: string;
  on(signal: Signal, handler: () => void): void;
  off(signal: Signal, handler: () => void): void;
  exit(code: number): void;
}

interface DenoSignals {
  addSignalListener(signal: Signal, handler: () => void): void;
  removeSignalListener(signal: Signal, handler: () => void): void;
  exit(code: number): void;
}

interface ProcessSignals {
  on(signal: Signal, handler: () => void): unknown;
  off?(signal: Signal, handler: () => void): unknown;
  removeListener?(signal: Signal, handler: () => void): unknown;
  exit(code: number): void;
}

/**
 * Deno first, on purpose. Its `node:process` shim does carry signal support, but `Deno.exit` and
 * `Deno.addSignalListener` are the APIs Deno itself documents, and a listener registered natively
 * is the one `removeSignalListener` can take back — which matters here, because a Deno signal
 * listener holds the process open until it is removed. Node and Bun share `process`.
 */
function signalApi(): SignalApi | undefined {
  const deno = (globalThis as { Deno?: DenoSignals }).Deno;

  if (typeof deno?.addSignalListener === 'function')
    return {
      runtime: 'deno',
      on: (signal, handler) => deno.addSignalListener(signal, handler),
      off: (signal, handler) => deno.removeSignalListener(signal, handler),
      exit: (code) => deno.exit(code),
    };

  const proc = (globalThis as { process?: ProcessSignals }).process;

  if (typeof proc?.on === 'function' && typeof proc.exit === 'function') {
    const remove = proc.off ?? proc.removeListener;

    return {
      runtime: 'node',
      on: (signal, handler) => void proc.on(signal, handler),
      off: (signal, handler) => void remove?.call(proc, signal, handler),
      exit: (code) => proc.exit(code),
    };
  }

  return undefined;
}

/**
 * Registers SIGINT/SIGTERM to run `close` and then exit. Returns the function that takes those
 * handlers back off — which is not optional bookkeeping on Deno, where a live signal listener keeps
 * the process from exiting on its own.
 *
 * The close is expected to unregister first thing, which leaves a **second signal falling through
 * to the platform default** — an immediate end to the process, teardown or no teardown. That is
 * the escape hatch, and it is deliberate: a developer pressing Ctrl-C twice wants out now, and
 * swallowing it for the length of a 10s shutdown budget would read as a hang. An orchestrator
 * sends `SIGTERM` once and then `SIGKILL`, so it never reaches this path.
 *
 * If the close throws, the process still exits — with 1, because a shutdown that failed halfway is
 * not a clean one and an orchestrator should be told.
 */
export function installSignalHandlers(close: () => Promise<void>, logger: Logger): () => void {
  const api = signalApi();

  if (!api) {
    logger.warn(
      'handleSignals: this runtime delivers no process signals, so nothing was registered — call close() yourself',
    );
    return () => {};
  }

  const registered: Array<[Signal, () => void]> = [];

  const remove = (): void => {
    while (registered.length) {
      const [signal, handler] = registered.pop()!;
      api.off(signal, handler);
    }
  };

  for (const signal of SIGNALS) {
    const handler = (): void => {
      logger.info(`${signal} received — closing`, { signal, runtime: api.runtime });
      void close().then(
        () => api.exit(0),
        (error: unknown) => {
          logger.error(`shutdown failed after ${signal}`, {
            signal,
            err: error instanceof Error ? error.message : String(error),
          });
          api.exit(1);
        },
      );
    };

    try {
      api.on(signal, handler);
      registered.push([signal, handler]);
    } catch (error) {
      // Deno throws for SIGTERM on Windows, where the signal does not exist. Registering what the
      // platform does have beats refusing to start over the one it does not.
      logger.warn(`handleSignals: ${signal} is unavailable on this platform — skipping it`, {
        signal,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return remove;
}
