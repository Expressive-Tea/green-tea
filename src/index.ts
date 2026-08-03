/**
 * @green-tea/core — a decorator-driven, type-safe HTTP framework.
 * Public API barrel: application bootstrap, routing/DI decorators, streaming,
 * request validation, security helpers, and the cross-server mesh.
 */
import 'reflect-metadata';

/** Package version, replaced at publish time. */
export const VERSION = '26.8.0-beta.0';

// Application
export { createApp } from './app';
export type { App, InspectLine, Explain, MeshConfig } from './app';

// Graph visualization
export { toMermaid, toDOT } from './graph-viz';
export type { GraphView } from './graph-viz';
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
export type { Transport, HttpMethod } from './metadata';
export type { Plugin } from './plugin';

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
} from './signals';

// Bus & flow
export { Bus } from './bus';
export { flow, Flow } from './flow';
export type { StepFn, CompiledFlow } from './flow';

// Parameter decorators
export { needs, ctx, param, query, body, headers, header, inbound, abort } from './params';
export type { Query, Headers, Context, ArgSpec } from './params';

// Streaming
export { channel, isAsyncIterable } from './channel';
export type { Channel } from './channel';
export { Rooms } from './rooms';
export { sseEncoder, ndjsonEncoder } from './encoders';
export type { StreamEncoder } from './encoders';

// HTTP, security & validation
export type { RequestLimits } from './http';
export type { TlsOptions, CorsOptions, SecurityOptions } from './security';
export type { UploadedFile, MultipartBody } from './multipart';
export type { StandardSchemaV1 } from './standard-schema';

// Mesh
export { connectLink } from './mesh/link';
export { buildRemote, envelopeFrom } from './mesh/teacup';
export { buildManifest, createMeshControl, MESH_CONTROL_PATH } from './mesh/teapot';
export type { Manifest, RequestEnvelope, Frame } from './mesh/protocol';
