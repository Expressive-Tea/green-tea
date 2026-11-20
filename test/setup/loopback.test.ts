// Guards test/setup/loopback.ts: if it stops applying, the port collisions behind #59 come back.
import { it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { createApp, Module } from '../../src/index';

@Module({ mountpoint: '/' })
class M {}

it('test servers listen on 127.0.0.1 when no host is given', async () => {
  const server = await createApp({ modules: [M] }).listen(0);
  const wss = new WebSocketServer({ port: 0 });
  try {
    await new Promise((resolve) => wss.once('listening', resolve));
    expect((server.address() as { address: string }).address).toBe('127.0.0.1');
    expect((wss.address() as { address: string }).address).toBe('127.0.0.1');
  } finally {
    server.close();
    wss.close();
  }
});
