import { describe, it, expect } from 'vitest';
import WebSocket from 'ws';
import { channel } from '../src/channel';
import { createHttpServer, type WsRouteDef } from '../src/http';

const url = (server: import('http').Server, path: string) => {
  const a = server.address();
  if (a && typeof a === 'object') return `ws://127.0.0.1:${a.port}${path}`;
  throw new Error('no address');
};

describe('ws upgrade', () => {
  it('echoes inbound to outbound and aborts on close', async () => {
    let aborted = false;
    const wsRoutes: WsRouteDef[] = [{
      pattern: '/echo',
      open: async ({ inbound, abort }) => {
        abort.addEventListener('abort', () => { aborted = true; });
        const out = channel<string>();
        (async () => { for await (const m of inbound) out.push(`echo:${m}`); out.close(); })();
        return out;
      },
    }];
    const server = createHttpServer([], wsRoutes);
    await new Promise<void>((r) => server.listen(0, r));

    const client = new WebSocket(url(server, '/echo'));
    await new Promise((r) => client.on('open', r));
    const got = new Promise<string>((r) => client.on('message', (d) => r(d.toString())));
    client.send('hi');
    expect(await got).toBe('echo:hi');
    client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(true);
    server.close();
  });
});
