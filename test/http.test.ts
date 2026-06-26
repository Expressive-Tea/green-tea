import { expect, test } from 'vitest';
import { matchRoute } from '../src/http';

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
