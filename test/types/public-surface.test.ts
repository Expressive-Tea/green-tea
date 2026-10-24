// The types D19 added to the barrel (CARD-22): each one appears in a public signature, so a user
// must be able to name it. This file's job is to fail to compile if one stops being exported.
import { test, expect } from 'vitest';
import {
  createApp,
  type App,
  type AppOptions,
  type ExplainNode,
  type RequestHeaders,
  type Headers,
  type WsRequest,
  type WsSocket,
} from '../../src';

// Options built apart from the call, the thing an inline type made impossible to annotate.
const options: AppOptions = { modules: [] };

// `app.upgrade(req, socket)`, wrapped by an adapter that has to declare what it passes.
const upgrade = (app: App, req: WsRequest, socket: WsSocket) => app.upgrade(req, socket);

const firstNeeds = (node: ExplainNode): string[] => node.needs;

// The deprecated alias is the same type, so existing imports keep compiling.
const headers: RequestHeaders = { 'x-a': 'b' };
const legacy: Headers = headers;

test('the D19 additions are typeable from the package barrel', () => {
  expect(typeof createApp(options).fetch).toBe('function');
  expect(typeof upgrade).toBe('function');
  expect(firstNeeds({ name: 'n', kind: 'step', origin: 'o', needs: ['a'], provides: [] })).toEqual(['a']);
  expect(legacy).toBe(headers);
});
