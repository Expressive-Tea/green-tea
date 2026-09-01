import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createApp, Module } from '../src';

@Module({ mountpoint: '/', controllers: [] })
class Empty {}

let app: ReturnType<typeof createApp> | undefined;
let child: ChildProcess | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  child?.kill('SIGKILL');
  child = undefined;
});

const disposed = (r: { lines: string[] }) => r.lines.filter((l) => l.includes('"disposed"'));
const handled = (r: { lines: string[] }) => r.lines.some((l) => l.includes('received — closing'));
const listeners = () => process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');

describe('handleSignals registration', () => {
  it('registers nothing by default — a library must not own when the process exits', async () => {
    const before = listeners();
    app = createApp({ modules: [Empty] });
    await app.listen(0);
    expect(listeners()).toBe(before);
  });

  it('registers SIGINT and SIGTERM when asked, and takes both back off in close()', async () => {
    const before = listeners();
    const opted = createApp({ modules: [Empty], handleSignals: true });
    await opted.listen(0);
    expect(listeners()).toBe(before + 2);

    // Not tidiness: on Deno a live signal listener holds the process open, so an app that closed
    // itself and expected to exit would hang. Node is where it is observable.
    await opted.close();
    expect(listeners()).toBe(before);
  });
});

/** Boots the harness app, waits for its `ready` line, and resolves once it has exited. */
function runHarness(signal: NodeJS.Signals, env: NodeJS.ProcessEnv = {}, sendTwice = false) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; lines: string[] }>((resolve, reject) => {
    // `process.execPath -r tsx/cjs`, not `npx tsx`: a wrapper puts the app one process further
    // down, and on Linux the signal then lands on the wrapper while the app never hears it — which
    // is exactly how this passed locally and failed in CI. `-r` rather than `--import`/`--loader`
    // because it is the one form that works on both the Node 18 floor CI builds against and the
    // current release.
    const proc = spawn(process.execPath, ['-r', 'tsx/cjs', 'test/interop/_signal-app.ts'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child = proc;

    const lines: string[] = [];
    let ready = false;
    let buffered = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';

      for (const line of parts.filter(Boolean)) {
        lines.push(line);
        if (!ready && line.includes('"ready"')) {
          ready = true;
          proc.kill(signal);
          if (sendTwice) setTimeout(() => proc.kill(signal), 20);
        }
      }
    });

    proc.on('error', reject);
    proc.on('exit', (code, exitSignal) => resolve({ code, signal: exitSignal, lines }));
  });
}

// These need a real process because the handler's job is to exit the one it runs in — firing it by
// hand in the test runner would either take the runner down or prove nothing.
describe('handleSignals end to end', () => {
  it('SIGTERM runs teardown and exits 0', { timeout: 20_000 }, async () => {
    const r = await runHarness('SIGTERM');
    expect(disposed(r)).toHaveLength(1);
    expect(r.code).toBe(0);
  });

  it('SIGINT does the same — Ctrl-C is not a different kind of shutdown', { timeout: 20_000 }, async () => {
    const r = await runHarness('SIGINT');
    expect(disposed(r)).toHaveLength(1);
    expect(r.code).toBe(0);
  });

  // The escape hatch, and the reason `close()` unregisters before it starts draining: a second
  // signal finds no handler and gets the platform default. Ctrl-C twice ends a stuck teardown
  // rather than waiting out the whole shutdown budget.
  it('lets a second signal end a shutdown that is still draining', { timeout: 20_000 }, async () => {
    const r = await runHarness('SIGTERM', { DISPOSE_DELAY_MS: '2000' }, true);
    expect(handled(r)).toBe(true); // the first signal was ours
    expect(disposed(r)).toHaveLength(0); // the second one did not wait for the 2s dispose
    expect(r.code).not.toBe(0);
  });

  it('leaves the process to its default fate when handleSignals is off', { timeout: 20_000 }, async () => {
    const r = await runHarness('SIGTERM', { HANDLE_SIGNALS: 'false' });
    expect(handled(r)).toBe(false); // nothing of ours ran at all
    expect(disposed(r)).toHaveLength(0);
    expect(r.code).not.toBe(0);
  });
});
