// `createApp({ handleSignals: true })` under the real Deno runtime.
//
// Deno is the runtime this option exists for. Node and Bun share `process.on`/`process.exit`; Deno
// has `Deno.addSignalListener`/`Deno.exit`, and its listeners hold the process open until removed —
// so an app that closed itself and forgot to unregister would hang here and nowhere else.
//
// Run with: npm run test:deno
import { assert, assertEquals } from 'jsr:@std/assert';

const HARNESS = 'test/interop/_signal-app-deno.ts';

async function run(): Promise<{ code: number; lines: string[] }> {
  const child = new Deno.Command('deno', {
    args: ['run', '--allow-all', '--no-check', HARNESS],
    stdout: 'piped',
    stderr: 'inherit',
  }).spawn();

  const lines: string[] = [];
  let buffered = '';
  let signalled = false;

  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const pump = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += value;
      const parts = buffered.split('\n');
      buffered = parts.pop() ?? '';
      for (const line of parts.filter(Boolean)) {
        lines.push(line);
        if (!signalled && line.includes('"ready"')) {
          signalled = true;
          child.kill('SIGTERM');
        }
      }
    }
  })();

  const status = await child.status;
  await pump;
  return { code: status.code, lines };
}

Deno.test('SIGTERM runs teardown and exits 0 through Deno.addSignalListener', async () => {
  const { code, lines } = await run();
  assert(
    lines.some((l) => l.includes('"disposed"')),
    `dispose() never ran — got: ${lines.join(' | ')}`,
  );
  assertEquals(code, 0);
});
