import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { Route, Get, Head, Options, Post, Ws, Module } from '../src/metadata';
import { param, query, headers, body } from '../src/params';

const numSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (v: unknown) => ({ value: Number(v) }),
  },
};

@Route('/users')
class Users {
  @Get('/:id(\\d+)') get(@param('id') _id: string, @query('expand') _e: string, @headers('x-trace') _t: string) {
    return {};
  }
  @Head('/:id(\\d+)') head() {
    return {};
  }
  @Options('/:id(\\d+)') options() {
    return {};
  }
  @Post('/') create(@body() _b: unknown) {
    return {};
  }
  @Get('/:id/files/:path*') files(@param('path') _p: string) {
    return {};
  }
  @Get('/search') search(@query('n', numSchema) _n: number) {
    return {};
  }
  @Ws('/live') live() {
    return (async function* () {})();
  }
}
@Module({ mountpoint: '/api', controllers: [Users] })
class M {}

describe('app.openapi()', () => {
  const doc = createApp({ modules: [M] }).openapi({ title: 'Demo', version: '1.2.3' });

  it('emits a 3.1 doc with info overrides', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({ title: 'Demo', version: '1.2.3' });
  });

  it('templates path params: /users/:id → /users/{id}', () => {
    expect(doc.paths['/api/users/{id}']).toBeDefined();
    expect(doc.paths['/api/users/{id}/files/{path}']).toBeDefined();
  });

  it('derives path, query, and header parameters from the handler signature', () => {
    const op = doc.paths['/api/users/{id}'].get as any;
    const byName = Object.fromEntries(op.parameters.map((p: any) => [p.name, p.in]));
    expect(byName).toEqual({ id: 'path', expand: 'query', 'x-trace': 'header' });
  });

  it('projects a constrained param into schema.pattern', () => {
    const op = doc.paths['/api/users/{id}'].get as any;
    expect(op.parameters).toContainEqual({
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'string', pattern: '\\d+' },
    });
  });

  it('includes explicit HEAD and OPTIONS without inventing automatic operations', () => {
    expect(doc.paths['/api/users/{id}'].head).toBeDefined();
    expect(doc.paths['/api/users/{id}'].options).toBeDefined();
    expect(doc.paths['/api/users/search'].head).toBeUndefined();
    expect(doc.paths['/api/users/search'].options).toBeUndefined();
  });

  it('marks routes that take a body with requestBody', () => {
    const op = doc.paths['/api/users'].post as any;
    expect(op.requestBody.content['application/json']).toBeDefined();
  });

  it('adds a 422 response when an argument is validated by a schema', () => {
    const op = doc.paths['/api/users/search'].get as any;
    expect(op.responses['422']).toBeDefined();
    expect((doc.paths['/api/users/{id}'].get as any).responses['422']).toBeUndefined();
  });

  it('omits WebSocket routes', () => {
    expect(doc.paths['/api/users/live']).toBeUndefined();
  });
});

describe('GET /__openapi__', () => {
  it('serves the document as JSON when devOpenapi is enabled', async () => {
    const app = createApp({ modules: [M], devOpenapi: true });
    const server = await app.listen(0);
    const port = (server.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/__openapi__`);
    expect(res.headers.get('content-type')).toBe('application/json');
    const json = (await res.json()) as any;
    expect(json.openapi).toBe('3.1.0');
    expect(json.paths['/api/users/{id}']).toBeDefined();
    server.close();
  });
});
