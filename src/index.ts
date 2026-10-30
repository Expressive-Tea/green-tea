/**
 * @green-tea/core — a decorator-driven, type-safe HTTP framework.
 * Public API barrel: application bootstrap, routing/DI decorators, streaming,
 * request validation, security helpers, and the cross-server mesh.
 */
import 'reflect-metadata';

/**
 * Package version. Kept in step with `package.json` and `deno.json` by hand, and pinned to them by
 * `test/package-metadata.test.ts`.
 *
 * It used to say it was "replaced at publish time", which nothing ever did — not `tsup`, not
 * `stage.yml`, not `release.yml`, which only ever *reads* the version out of `package.json`. So the
 * constant drifted two releases behind while the comment explained why it could not, and the only
 * test touching it checked the CalVer shape, which a stale version satisfies perfectly.
 */
export const VERSION = '26.9.0-beta.2';

// Application
export { createApp } from './app';
export type { App, AppOptions, InspectLine, Explain, ExplainNode, MeshConfig } from './app';

// Graph visualization
export { toMermaid, toDOT } from './graph-viz';
export type { GraphView, GraphNodeView, GraphRouteView } from './graph-viz';
export { buildOpenApi } from './openapi';
export type { OpenApiDoc, OpenApiInfo, OpenApiRoute } from './openapi';

// Views
export { render } from './views';

// Routing & decorators
export {
  Provider,
  Step,
  Route,
  Get,
  Head,
  Module,
  Transformer,
  Sse,
  Ws,
  Stream,
  Post,
  Put,
  Patch,
  Delete,
  Options,
  Html,
} from './metadata';
export type { Transport, HttpMethod, RouteDecorator, TransformerFn, ModuleOptions, Ctor } from './metadata';
export type { Plugin, PluginApi, ScopeApi, ScopeNode } from './plugin';
export type { Hooks } from './app';
export type { TeardownFn } from './lifecycle';

// Transformers & error signals
export { JsonTransformer } from './transformers';
export type { ErrorRenderer, ErrorRequest, ErrorResponse } from './transformers';
export {
  HttpError,
  Unauthorized,
  NotFound,
  Redirect,
  NotModified,
  ValidationError,
  TransportMismatchError,
  HTTP_ERROR,
  VALIDATION_ERROR,
  isHttpError,
  isValidationError,
} from './signals';
export type { HttpErrorLike } from './signals';

// Bus & flow
export { Bus } from './bus';
export type { LifecycleEvent, EventPayload, Correlation, Events } from './bus';
export { flow, Flow } from './flow';
export type { StepFn, CompiledFlow } from './flow';

// Parameter decorators
export { needs, ctx, param, query, body, headers, header, cookies, cookie, inbound, abort } from './params';
export type { Query, RequestHeaders, Headers, Context, ArgSpec, ArgSource, ArgDecorator } from './params';

// Cookies
export { setCookie, parseCookies } from './cookies';
export type { CookieOptions } from './cookies';

// Observability
export { createDefaultLogger, logRequests, withConsoleFallback } from './logger';
export type { Logger, LogLevel, LogFields, BusLike } from './logger';

// Streaming
export { channel, isAsyncIterable } from './channel';
export type { Channel } from './channel';
export { Rooms } from './rooms';
export { sse, isSseEvent, sseEncoder, ndjsonEncoder } from './encoders';
export type { StreamEncoder, SseEvent, SseFields } from './encoders';

// HTTP, security & validation
export type { RequestLimits } from './http';
export type { WsRequest, WsSocket } from './http/ws-core';
export type { CompressionOptions } from './http/compression';
export { UNMATCHED_ROUTE } from './http/core';
export type { TlsOptions, CorsOptions, SecurityOptions } from './security';
export type { UploadedFile, MultipartBody } from './multipart';
export type { StandardSchemaV1, StandardIssue, StandardResult } from './standard-schema';

// Mesh — experimental (`createApp({ experimental: true })`): outside the API freeze, may change in a minor.
export { connectLink } from './mesh/link';
export { buildRemote, envelopeFrom } from './mesh/teacup';
export { buildManifest, createMeshControl, MESH_CONTROL_PATH } from './mesh/teapot';
export type { Manifest, RequestEnvelope, Frame, RouteEntry } from './mesh/protocol';
export type { Link, ManifestPolicy, ReconnectOptions } from './mesh/link';
export type { SocketCtor, EventfulSocket } from './http/ws-adapter';
export type { RemoteScopeNode, RemoteRoute } from './mesh/teacup';
export type { MeshControlDeps } from './mesh/teapot';
export type { ResponseShape } from './pipeline';
