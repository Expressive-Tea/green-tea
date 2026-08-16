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
