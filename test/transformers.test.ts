import { expect, test } from 'vitest';
import { JsonTransformer, errorToResponse } from '../src/transformers';
import { Unauthorized, Redirect } from '../src/signals';

test('JsonTransformer serializes value with json content-type', () => {
  expect(JsonTransformer({ a: 1 })).toEqual({
    status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}',
  });
});

test('errorToResponse maps HttpError to its status', () => {
  const r = errorToResponse(new Unauthorized('nope'));
  expect(r.status).toBe(401);
  expect(JSON.parse(r.body)).toEqual({ error: 'nope' });
});

test('errorToResponse sets location for Redirect', () => {
  expect(errorToResponse(new Redirect('/login')).headers.location).toBe('/login');
});

test('unknown error becomes 500', () => {
  expect(errorToResponse(new Error('boom')).status).toBe(500);
});
