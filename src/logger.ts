import type { EventPayload } from './bus';

/**
 * The logging contract. Four levels, because four have callers: core diagnostics are all `warn`
 * today, request logging adds `info` and `error`, and the graph diagnostics add `debug`. No
 * `trace`, no `fatal`, no `silent` — a level nothing emits is a decision handed to the user for
 * no reason.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured context attached to a log record. Flattened into the JSON output alongside the message. */
export type LogFields = Record<string, unknown>;

/**
 * What `createApp({ logger })` accepts, and what core writes every diagnostic through.
 *
 * Message first, fields second, so a call reads as a sentence and the structured part stays
 * optional. Bridging a `pino`- or `winston`-style logger is a four-line adapter in either
 * direction; core defines the shape it needs rather than adopting anyone's.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/**
 * Whether output should be human-readable rather than JSON.
 *
 * Decided once, when the logger is built, and never per call — the answer cannot change while the
 * process runs, and asking on every record would put a syscall-shaped question on a path that is
 * supposed to be cheap. `process` is absent on the edge, so the guard is not defensive padding:
 * unattended is the correct default there, and JSON is the unattended format.
 */
function isInteractive(): boolean {
  const proc = (globalThis as { process?: { stdout?: { isTTY?: boolean } } }).process;
  return Boolean(proc?.stdout?.isTTY);
}

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

function renderPretty(level: LogLevel, message: string, fields?: LogFields): string {
  const pairs = fields
    ? Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    : [];

  return `[green-tea] ${level.toUpperCase()} ${message}${pairs.length ? ' ' + pairs.join(' ') : ''}`;
}

function renderJson(level: LogLevel, message: string, fields?: LogFields): string {
  // `name` rather than the `[green-tea]` prefix the messages used to carry inline: a log
  // aggregator filters on a field, and cannot filter on a substring of prose.
  return JSON.stringify({ level, time: new Date().toISOString(), name: 'green-tea', msg: message, ...fields });
}

/**
 * Wraps a logger so a throwing one cannot go silent.
 *
 * `Bus.emit` isolates listener failures on purpose — an observer must never be able to break a
 * request — but that guarantee has a cost when the observer is the logger itself: a user logger
 * that throws would simply stop writing, with nothing to say so. Falling back to `console` keeps
 * the Bus's promise without paying for it in silence.
 *
 * Exported because request logging is not the only thing that should survive a broken logger.
 */
export function withConsoleFallback(logger: Logger): Logger {
  const guard =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      try {
        logger[level](message, fields);
      } catch (error) {
        console.error(
          renderJson('error', 'the configured logger threw; falling back to console', {
            level,
            originalMessage: message,
            error: error instanceof Error ? error.message : String(error),
            ...fields,
          }),
        );
      }
    };

  return { debug: guard('debug'), info: guard('info'), warn: guard('warn'), error: guard('error') };
}

/**
 * Subscribes request logging to the lifecycle stream: `info` per completed request, `error` per
 * failed one. Returns an unsubscribe function, so it is as removable as it is composable — which
 * is what "a composable step, not a global middleware" has to mean in practice.
 *
 * Reads the stream rather than being called from the request path, so there is exactly one account
 * of what happened to a request. A second path would eventually disagree with the first.
 */
export function logRequests(bus: BusLike, logger: Logger): () => void {
  const safe = withConsoleFallback(logger);
  const offEnd = bus.on('request:end', (event) => {
    safe.info(`${event.method ?? ''} ${event.route ?? event.name} ${event.status ?? ''}`.trim(), {
      requestId: event.requestId,
      traceId: event.traceId,
      route: event.route,
      method: event.method,
      status: event.status,
      durationMs: event.durationMs,
    });
  });
  const offFailed = bus.on('request:failed', (event) => {
    safe.error(`${event.method ?? ''} ${event.route ?? event.name} failed`.trim(), {
      requestId: event.requestId,
      traceId: event.traceId,
      route: event.route,
      method: event.method,
      error: event.error instanceof Error ? event.error.message : event.error,
    });
  });

  return () => {
    offEnd();
    offFailed();
  };
}

/** The slice of {@link Bus} request logging needs — `on` only, matching what a plugin is handed. */
interface BusLike {
  on(event: 'request:end' | 'request:failed', listener: (payload: EventPayload) => void): () => void;
}

/**
 * The logger used when `createApp` is given none: structured JSON, or human-readable on a TTY.
 *
 * Writes through `console`, which is the whole reason core can have a logging contract without a
 * logging dependency — `reflect-metadata` stays the only runtime dependency, and anything richer
 * (transports, sampling, rotation) is a `Logger` a user passes in.
 */
export function createDefaultLogger(pretty: boolean = isInteractive()): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    console[CONSOLE_METHOD[level]](pretty ? renderPretty(level, message, fields) : renderJson(level, message, fields));
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
