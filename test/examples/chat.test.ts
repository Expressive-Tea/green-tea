import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../../example/chat';

let server: any; let port: number;
afterAll(() => server?.close());

describe('chat example', () => {
  it('two authed clients in a room see each other; missing token is rejected 4401', async () => {
    server = await app.listen(0); port = (server.address() as any).port;
    const WebSocket = (await import('ws')).default;

    const a = new WebSocket(`ws://127.0.0.1:${port}/chat/general?token=alice`);
    const b = new WebSocket(`ws://127.0.0.1:${port}/chat/general?token=bob`);
    await Promise.all([new Promise((r) => a.on('open', r)), new Promise((r) => b.on('open', r))]);
    const bGot = new Promise<string>((r) => b.on('message', (d: Buffer) => r(d.toString())));
    await new Promise((r) => setTimeout(r, 50));   // let server-side open()/subscribe complete (channel has no replay)
    a.send('hi');
    expect(await bGot).toContain('hi');
    a.close(); b.close();

    const noTok = new WebSocket(`ws://127.0.0.1:${port}/chat/general`);
    const code = await new Promise<number>((r) => noTok.on('close', (c: number) => r(c)));
    expect(code).toBe(4401);
  });
});
