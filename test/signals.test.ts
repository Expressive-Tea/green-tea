import { expect, test } from 'vitest';
import { HttpError, Unauthorized, Redirect, NotModified, NotFound, isHttpError } from '../src/signals';

test('Unauthorized carries status 401', () => {
  const e = new Unauthorized('no token');
  expect(e.status).toBe(401);
  expect(e.message).toBe('no token');
  expect(isHttpError(e)).toBe(true);
});

test('Redirect carries location and status 302', () => {
  const e = new Redirect('/login');
  expect(e.status).toBe(302);
  expect(e.location).toBe('/login');
});

test('NotModified is 304, NotFound is 404', () => {
  expect(new NotModified().status).toBe(304);
  expect(new NotFound().status).toBe(404);
});

test('isHttpError rejects plain errors', () => {
  expect(isHttpError(new Error('x'))).toBe(false);
});
