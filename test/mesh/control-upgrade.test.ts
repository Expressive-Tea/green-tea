import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { createHttpServer, type MeshControl } from '../../src/http';

describe('mesh control upgrade', () => {
  it('routes the reserved path to meshControl.handle and leaves wsRoutes intact', async () => {
    let handled = false;
    const meshControl: MeshControl = { path: '/__mesh__/control', handle: (ws) => { handled = true; ws.send('hi'); } };
    const server = createHttpServer([], [], undefined, meshControl);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/__mesh__/control`);
    const msg = await new Promise<string>((res) => { client.on('message', (d) => res(d.toString())); });
    expect(msg).toBe('hi');
    expect(handled).toBe(true);
    client.close(); server.close();
  });
});
