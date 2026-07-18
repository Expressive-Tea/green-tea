import { describe, it, expect } from 'vitest';
import { createApp, Route, Ws, Module, ctx, Step, needs } from '../src/index';
import { channel } from '../src/channel';
import type { WsSocket, WsRequest } from '../src/http/ws-core';

@Route('/rt')
class Rt {
  @Ws('/echo')
  echo(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `echo:${msg}`;
    })();
  }
}
@Module({ mountpoint: '/', controllers: [Rt] })
class M {}
const app = createApp({ modules: [M] });

@Step({ provides: 'tag' })
class Tagger {
  run() {
    return { tag: 't' };
  }
}
@Route('/tagged')
class TaggedCtl {
  @Ws('/echo')
  echo(@needs('tag') tag: string, @ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `${tag}:${msg}`;
    })();
  }
}
@Module({ mountpoint: '/', steps: [Tagger], controllers: [TaggedCtl] })
class Tagged {}

function fakeSocket() {
  const inbound = channel<unknown>();
  const ac = new AbortController();
  const sent: string[] = [];
  const socket: WsSocket = {
    inbound,
    abort: ac.signal,
    isOpen: true,
    send: (d) => sent.push(d),
    close: () => ac.abort(),
    terminate: () => ac.abort(),
  };
  return { socket, inbound, sent };
}

describe('app.upgrade', () => {
  it('routes a matching ws path through the graph', async () => {
    const { socket, inbound, sent } = fakeSocket();
    const req: WsRequest = { url: '/rt/echo', headers: {}, protocol: 'http', ip: '' };
    const run = app.upgrade(req, socket);
    // let the handler's async generator start subscribing to `inbound` (channel is fan-out:
    // push before subscription is lost) before pushing — a macrotask flushes every pending
    // microtask in the upgrade/boot chain first, so this is deterministic, not a sleep-and-hope.
    await new Promise((resolve) => setTimeout(resolve, 0));
    inbound.push('hi');
    inbound.close();
    await run;
    expect(sent).toEqual(['echo:hi']);
  });

  it('emits request:step:enter/leave for ws steps, like HTTP routes do', async () => {
    const seen: string[] = [];
    const logger = (api: any) => {
      api.bus.on('request:step:enter', (p: any) => seen.push(`enter:${p.name}`));
      api.bus.on('request:step:leave', (p: any) => seen.push(`leave:${p.name}`));
    };
    const wsApp = createApp({ modules: [Tagged], plugins: [logger] });
    const { socket, inbound, sent } = fakeSocket();
    const req: WsRequest = { url: '/tagged/echo', headers: {}, protocol: 'http', ip: '' };
    const run = wsApp.upgrade(req, socket);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inbound.push('hi');
    inbound.close();
    await run;

    expect(sent).toEqual(['t:hi']);
    expect(seen).toEqual(['enter:tag', 'leave:tag']);
  });

  it('closes 1008 on an unknown ws path', async () => {
    const { socket } = fakeSocket();
    let closedCode: number | undefined;
    socket.close = (c) => {
      closedCode = c;
    };
    const req: WsRequest = { url: '/rt/nope', headers: {}, protocol: 'http', ip: '' };
    await app.upgrade(req, socket);
    expect(closedCode).toBe(1008);
  });
});
