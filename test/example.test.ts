import { expect, test } from 'vitest';
import { app } from '../example/server';

test('example: inspect shows graph-ordered chain', () => {
  expect(app.inspect('/api/users/:id').map((l) => `${l.kind}:${l.name}`))
    .toEqual(['provider:db', 'step:user', 'handler:getUser']);
});

test('example: authenticated request returns the user', async () => {
  const server = await app.listen(0);
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/users/9`, { headers: { 'x-token': 'u1' } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ requested: '9', you: { id: 'u1', name: 'Diego' } });
  server.close();
});
