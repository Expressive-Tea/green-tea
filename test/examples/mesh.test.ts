// The mesh REST demo (example/mesh), across two real processes: billing runs as a child process so
// the test can kill it and start it again, and the shop runs here. Guards the demo against rot (#88).
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { MESH_CONTROL_PATH } from '../../src/index';
import { createShop } from '../../example/mesh/shop';

const ROOT = join(__dirname, '..', '..');

/** Starts example/mesh/billing.ts as its own process and resolves once it is listening. */
function startBilling(port = 0): Promise<{ child: ChildProcess; port: number }> {
  // `node --import tsx` rather than the `tsx` binary, which runs the app in a child of its own: killing
  // the wrapper would leave the real server up, and the test would never see billing die.
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'example', 'mesh', 'billing.ts')], {
    cwd: ROOT,
    env: { ...process.env, BILLING_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk) => {
      out += chunk;
      const match = /billing \(teapot\) on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match) resolve({ child, port: Number(match[1]) });
    });
    child.once('exit', (code) => reject(new Error(`billing exited early (${code}): ${out}`)));
  });
}

/** Polls until `check` passes; the mesh reacts to a dead or returning peer within a second or so. */
async function eventually(check: () => Promise<void>, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;

  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

const children: ChildProcess[] = [];
let closeShop: (() => Promise<void>) | undefined;

afterAll(async () => {
  await closeShop?.();
  for (const child of children) child.kill('SIGKILL');
});

describe('mesh REST demo', () => {
  it('serves across processes, answers 503 while billing is down, and recovers', async () => {
    const first = await startBilling();
    children.push(first.child);

    const shop = createShop(`ws://127.0.0.1:${first.port}${MESH_CONTROL_PATH}`);
    const server = await shop.listen(0);
    closeShop = async () => {
      await shop.close();
      server.close();
    };
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const get = (path: string) => fetch(`${base}${path}`);
    const json = async (path: string): Promise<any> => (await get(path)).json();

    // A local route that needs a remote step: `balance` is computed on billing from this request's params.
    expect(await (await get('/shop/checkout/ada')).json()).toEqual({ customer: 'ada', due: 40, canCheckout: false });

    // Billing's own REST routes, served by the shop.
    const created = await fetch(`${base}/billing/invoices/ada`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ amount: 10, paid: false });
    expect((await json('/billing/invoices/ada')).invoices).toHaveLength(2);
    expect((await json('/shop/checkout/ada')).due).toBe(50);

    // Billing's validation error crosses the hop with its status and message.
    const invalid = await fetch(`${base}/billing/invoices/ada`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: -1 }),
    });
    expect(invalid.status).toBe(422);

    // Billing dies: both kinds of remote export answer 503 with retry-after, and the shop stays up.
    first.child.kill('SIGKILL');
    await eventually(async () => {
      const res = await get('/shop/checkout/ada');
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBeTruthy();
    });
    expect((await get('/billing/invoices/ada')).status).toBe(503);

    // Billing comes back on the same port: the shop reconnects on its own and serves again. The
    // ledger is in memory, so it starts over.
    const second = await startBilling(first.port);
    children.push(second.child);
    await eventually(async () => {
      expect(await (await get('/shop/checkout/ada')).json()).toEqual({ customer: 'ada', due: 40, canCheckout: false });
    });
  }, 30_000);
});
