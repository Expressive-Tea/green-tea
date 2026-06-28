import { describe, it, expect, afterAll } from 'vitest';
import { app } from '../../example/graphql';

let server: any; let base: string;
afterAll(() => server?.close());
const gql = (query: string, variables?: any) =>
  fetch(`${base}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) }).then((r) => r.json() as Promise<any>);

describe('graphql example', () => {
  it('runs a query and a mutation, and streams a subscription over SSE', async () => {
    server = await app.listen(0); base = `http://127.0.0.1:${(server.address() as any).port}`;

    expect(await gql('{ messages { text } }')).toMatchObject({ data: { messages: expect.any(Array) } });

    const res = await fetch(`${base}/graphql/stream`, { headers: { accept: 'text/event-stream' } });
    const reader = res.body!.getReader();
    await new Promise((r) => setTimeout(r, 50));   // let the subscription subscribe to the room before publishing
    await gql('mutation($t:String!){ postMessage(text:$t){ text } }', { t: 'hello-sub' });
    const dec = new TextDecoder(); let buf = '';
    while (!buf.includes('hello-sub')) buf += dec.decode((await reader.read()).value);
    expect(buf).toContain('hello-sub');
    await reader.cancel();
  });
});
