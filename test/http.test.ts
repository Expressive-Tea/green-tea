import { expect, test } from 'vitest';
import { matchRoute, parseQuery, createHttpServer } from '../src/http';

const handler = async () => ({ status: 200, headers: {}, body: 'ok' });

test('matches a static + :param route and extracts params', () => {
  const routes = [{ method: 'GET', pattern: '/api/users/:id', handler }];
  const m = matchRoute(routes, 'GET', '/api/users/42');
  expect(m?.params).toEqual({ id: '42' });
});

test('returns undefined when nothing matches', () => {
  const routes = [{ method: 'GET', pattern: '/api/users/:id', handler }];
  expect(matchRoute(routes, 'GET', '/api/orders/1')).toBeUndefined();
  expect(matchRoute(routes, 'POST', '/api/users/1')).toBeUndefined();
});

test('parseQuery extracts query params from a url', () => {
  expect(parseQuery('/api/users/9?q=hi&date=2026')).toEqual({ q: 'hi', date: '2026' });
  expect(parseQuery('/api/users/9')).toEqual({});
});

test('server parses json body and rejects malformed json with 400', async () => {
  const server = createHttpServer([{
    method: 'POST', pattern: '/echo',
    handler: async (req) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ got: req.body, q: req.query }) }),
  }]);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;

  const ok = await fetch(`http://127.0.0.1:${port}/echo?x=1`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }),
  });
  expect(await ok.json()).toEqual({ got: { a: 1 }, q: { x: '1' } });

  const bad = await fetch(`http://127.0.0.1:${port}/echo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  expect(bad.status).toBe(400);

  server.close();
});
