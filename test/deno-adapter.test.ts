import { afterEach, expect, it, vi } from 'vitest';
import type { App } from '../src/app/types';
import { serveDeno } from '../src/deno';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('snapshots connection metadata before Deno invalidates the upgraded request', async () => {
  let upgraded = false;
  let handler: ((request: Request, info: unknown) => Response | Promise<Response>) | undefined;
  const socket = {
    readyState: 1,
    binaryType: '',
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
  };

  vi.stubGlobal('Deno', {
    serve: (_options: unknown, next: typeof handler) => {
      handler = next;
      return { finished: Promise.resolve(), shutdown: vi.fn() };
    },
    upgradeWebSocket: () => {
      upgraded = true;
      return { socket, response: new Response() };
    },
  });

  const upgrade = vi.fn().mockResolvedValue(undefined);
  serveDeno({ upgrade } as unknown as App);
  const info = {
    get remoteAddr() {
      if (upgraded) throw new TypeError('Request closed');
      return { hostname: '127.0.0.1', port: 1234, transport: 'tcp' };
    },
  };
  const request = new Request('http://localhost/socket?token=x', {
    headers: { upgrade: 'websocket', 'x-test': 'yes' },
  });

  expect(() => handler!(request, info)).not.toThrow();
  await vi.waitFor(() =>
    expect(upgrade).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/socket?token=x', ip: '127.0.0.1' }),
      expect.any(Object),
    ),
  );
});
