import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp, createDefaultLogger, Route, Get, Step, Module, Provider, needs } from '../src/index';
import type { Logger, LogFields } from '../src/index';

/** Captures every call so a test can assert on what core wrote rather than on console output. */
function recordingLogger(): Logger & { records: Array<{ level: string; message: string; fields?: LogFields }> } {
  const records: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const at =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      records.push({ level, message, fields });
    };

  return { records, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('default logger', () => {
  it('writes one JSON object per record when not on a TTY', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDefaultLogger(false).warn('something happened', { route: '/x', count: 2 });

    expect(spy).toHaveBeenCalledTimes(1);
    const written = JSON.parse(spy.mock.calls[0][0] as string);
    expect(written).toMatchObject({ level: 'warn', name: 'green-tea', msg: 'something happened', route: '/x', count: 2 });
    // A log aggregator filters on a field; it cannot filter on a substring of prose.
    expect(written.msg).not.toContain('[green-tea]');
    expect(typeof written.time).toBe('string');
  });

  it('writes a readable line instead when interactive', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createDefaultLogger(true).warn('something happened', { route: '/x' });

    const written = spy.mock.calls[0][0] as string;
    expect(written).toBe('[green-tea] WARN something happened route=/x');
  });

  it('routes each level to the matching console method', () => {
    const spies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
    const logger = createDefaultLogger(false);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    for (const spy of Object.values(spies)) expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('createApp({ logger })', () => {
  @Route('/')
  class Ctl {
    @Get('/ok')
    ok() {
      return { ok: true };
    }
  }
  @Module({ mountpoint: '/', controllers: [Ctl] })
  class M {}

  it('sends framework diagnostics to the supplied logger, not to console', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logger = recordingLogger();
    const app = createApp({ modules: [M], logger });

    // close({ timeoutMs }) on an app that never listen()ed is one of the diagnostics core emits.
    await app.close({ timeoutMs: 100 });

    expect(logger.records).toHaveLength(1);
    expect(logger.records[0].level).toBe('warn');
    expect(logger.records[0].message).toContain('has no listen()ed server');
    // The point of the contract: nothing reached console behind the logger's back.
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('exposes the logger on the app so adapters and plugins share it', () => {
    const logger = recordingLogger();
    expect(createApp({ modules: [M], logger }).logger).toBe(logger);
  });

  it('warns about a deep dependency chain through the logger, with structured fields', () => {
    const logger = recordingLogger();

    @Step({ provides: 's0' })
    class S0 {
      run() {
        return { s0: 0 };
      }
    }
    @Step({ provides: 's1', needs: ['s0'] })
    class S1 {
      run() {
        return { s1: 1 };
      }
    }
    @Route('/deep')
    class DeepCtl {
      @Get('/go')
      go(@needs('s1') s: unknown) {
        return { s };
      }
    }
    @Module({ mountpoint: '/', steps: [S0, S1], controllers: [DeepCtl] })
    class DeepModule {}

    createApp({ modules: [DeepModule], logger, warnGraphDepth: 1 });

    const warned = logger.records.find((r) => r.message.includes('unusually deep'));
    expect(warned).toBeDefined();
    // Structured, so a dashboard can group by route instead of parsing the sentence.
    expect(warned!.fields).toMatchObject({ route: '/deep/go', method: 'GET', depth: 2, threshold: 1 });
  });
});

describe('logger as a dependency', () => {
  it('is injectable with @needs("logger") and is the same instance', async () => {
    const logger = recordingLogger();
    let seen: unknown;

    @Provider({ provides: 'noop' })
    class Noop {
      provide() {
        return { noop: 1 };
      }
    }
    @Route('/')
    class Ctl {
      @Get('/log')
      log(@needs('logger') injected: Logger) {
        seen = injected;
        injected.info('from a handler', { where: 'handler' });
        return { ok: true };
      }
    }
    @Module({ mountpoint: '/', providers: [Noop], controllers: [Ctl] })
    class M {}

    const app = createApp({ modules: [M], logger });
    await app.fetch(new Request('http://x/log'));

    // One object, two access paths — not a second logger wired into the graph.
    expect(seen).toBe(logger);
    expect(logger.records).toContainEqual({ level: 'info', message: 'from a handler', fields: { where: 'handler' } });
  });
});
