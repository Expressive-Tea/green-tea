// The teapot's frame loop under Deno, driven by a raw client rather than by another green-tea.
//
// The two guards here are close-code behaviour, and close codes are exactly where the runtimes
// have already differed once — a client may only send 1000 or 3000-4999, which is why the mesh
// heartbeat uses 4011 instead of 1011. Server-side closes deserve the same suspicion.
//
// Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { createApp, Step, Module } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

@Step({ provides: 'auth', needs: [], export: true })
class Auth {
  run() {
    return { auth: { ok: true } };
  }
}
@Module({ mountpoint: '/api', steps: [Auth] })
class TeapotModule {}

async function startTeapot() {
  const app = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: 'good' } });
  let port = 0;
  const server = serveDeno(app, { port: 0, onListen: (addr) => (port = addr.port) });
  await new Promise((r) => setTimeout(r, 50));

  return { port: () => port, stop: async () => { await server.shutdown(); await app.close(); } };
}

/** Opens a raw control-channel socket and resolves with how it ended. */
function rawClient(port: number, send: string): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__mesh__/control`);
    ws.onopen = () => ws.send(send);
    ws.onclose = (event) => resolve({ code: event.code });
    ws.onerror = () => reject(new Error('socket errored'));
  });
}

Deno.test('mesh on Deno: the teapot hangs up on an oversized control frame', async () => {
  const teapot = await startTeapot();

  try {
    // over the 4,000,000-character cap, and sent by a peer that has not authenticated
    const oversized = `{"type":"hello","v":1,"secret":"${'a'.repeat(4_000_001)}"}`;
    const { code } = await rawClient(teapot.port(), oversized);

    assertEquals(code, 1009);
  } finally {
    await teapot.stop();
  }
});
