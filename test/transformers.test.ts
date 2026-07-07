import { describe, expect, it, test } from 'vitest';
import { JsonTransformer, errorToResponse } from '../src/transformers';
import { HttpError, Unauthorized, Redirect, ValidationError } from '../src/signals';

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

describe('errorToResponse ValidationError', () => {
  it('maps ValidationError to 422 with source + flattened issues (before generic HttpError)', () => {
    const err = new ValidationError([{ message: 'Invalid email', path: ['email'] }], 'body');
    const r = errorToResponse(err);
    expect(r.status).toBe(422);
    expect(JSON.parse(r.body)).toEqual({
      error: 'Validation failed', source: 'body',
      issues: [{ path: 'email', message: 'Invalid email' }],
    });
  });
  it('still maps a plain HttpError to { error: message }', () => {
    const r = errorToResponse(new HttpError(403, 'Nope'));
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: 'Nope' });
  });
});
