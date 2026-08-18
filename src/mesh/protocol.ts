/**
 * Version of the mesh wire protocol. Peers are separate processes on separate deploy
 * cadences — possibly on different runtimes — so the frame shapes are a contract between
 * green-tea versions, not an internal detail. Peers refuse each other on mismatch rather
 * than misparsing downstream.
 *
 * **This is a compatibility boundary, not a changelog.** Bump it only when a peer running the
 * old version would *misparse a frame or misbehave silently*:
 *
 * - removing or renaming a field, or changing its type or meaning;
 * - adding a **required** field;
 * - adding a frame type that expects an answer — an old peer cannot decode it, drops it as
 *   undecodable, and the sender waits for a reply that will never come.
 *
 * Adding an **optional** field is not one of those: `decode` validates only the fields a frame
 * type requires and passes extras through untouched, so an old peer ignores what it does not
 * know and keeps answering. That is degraded, not broken, and does not earn a bump.
 *
 * Bumping per change would make the number mean "work happened" rather than "we are
 * incompatible", which is the one thing it is here to say.
 */
export const MESH_PROTOCOL_VERSION = 1;

/**
 * Serialized request context sent across the mesh for a scope or route RPC.
 *
 * `correlation` and `url` are optional by protocol, not by intent: a teapot running an older
 * green-tea simply ignores them, which costs the correlation of that hop and nothing else.
 */
export interface RequestEnvelope {
  method: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  /** The requested URL, so a teapot's handler sees the same path its caller did. */
  url?: string;
  /**
   * The caller's request identity, so a request that crosses the mesh keeps one id end to end.
   * Without it every hop opens a new investigation, in the one place a distributed trace is
   * the whole point.
   */
  correlation?: { requestId?: string; traceId?: string };
}

/** Manifest entry for an exported scope token and its lifetime. */
export interface ScopeEntry {
  token: string;
  scope: 'app' | 'request';
}
/** Manifest entry for an exported route. */
export interface RouteEntry {
  method: string;
  pattern: string;
}
/** A mesh server's advertised scopes and routes. */
export interface Manifest {
  scopes: ScopeEntry[];
  routes: RouteEntry[];
}

/**
 * Discriminated union of every message on the mesh wire. The handshake frames carry `v`.
 *
 * `ping`/`pong` are application frames rather than WebSocket protocol pings on purpose: the `ws`
 * package exposes `ws.ping()`, but the platform `WebSocket` that Deno and Bun provide does not,
 * so a protocol-level heartbeat could not work on every runtime mesh claims to support.
 */
export type Frame =
  | { type: 'hello'; v: number; secret: string }
  | { type: 'manifest'; v: number; scopes: ScopeEntry[]; routes: RouteEntry[] }
  | { type: 'rpc-req'; id: string; kind: 'scope' | 'route'; name: string; ctx: RequestEnvelope }
  | { type: 'rpc-res'; id: string; ok: true; result: unknown }
  | { type: 'rpc-res'; id: string; ok: false; error: { message: string; status?: number } }
  | { type: 'ping' }
  | { type: 'pong' };

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): boolean => typeof value === 'number';
const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null;

/** Rejects a frame whose fields don't match its `type` tag. `bad` always throws. */
type ShapeCheck = (frame: Record<string, unknown>, bad: (why: string) => never) => void;

/**
 * Field checks per frame type. `decode` is the mesh's trust boundary: past it, frames are fed
 * straight to the scope/route resolvers, so a bad shape must die here rather than surface as a
 * confusing failure downstream. A new frame type must add a row — the compiler fails until it does.
 */
const SHAPE: Record<Frame['type'], ShapeCheck> = {
  hello: (frame, bad) => {
    if (!isNumber(frame.v)) bad('missing protocol version');
    if (!isString(frame.secret)) bad('secret must be a string');
  },
  manifest: (frame, bad) => {
    if (!isNumber(frame.v)) bad('missing protocol version');
    if (!Array.isArray(frame.scopes) || !Array.isArray(frame.routes)) bad('scopes and routes must be arrays');
  },
  'rpc-req': (frame, bad) => {
    if (!isString(frame.id)) bad('id must be a string');
    if (frame.kind !== 'scope' && frame.kind !== 'route') bad("kind must be 'scope' or 'route'");
    if (!isString(frame.name)) bad('name must be a string');
    if (!isObject(frame.ctx)) bad('ctx must be an object');
  },
  'rpc-res': (frame, bad) => {
    if (!isString(frame.id)) bad('id must be a string');
    if (typeof frame.ok !== 'boolean') bad('ok must be a boolean');
    if (frame.ok === false && !isObject(frame.error)) bad('error must be an object when ok is false');
  },
  ping: () => {
    /* the tag is the whole frame */
  },
  pong: () => {
    /* the tag is the whole frame */
  },
};

/** Serialize a frame to a JSON wire string. */
export function encode(frame: Frame): string {
  return JSON.stringify(frame);
}

/** Parse a wire string into a frame, throwing if the `type` tag is unknown or the shape is malformed. */
export function decode(json: string): Frame {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const type = parsed.type;
  // own-property check, not a bare lookup: `type` is peer-controlled, and SHAPE['constructor']
  // would otherwise resolve up the prototype chain to a truthy non-check.
  const known = isString(type) && Object.prototype.hasOwnProperty.call(SHAPE, type);
  const check = known ? SHAPE[type as Frame['type']] : undefined;

  if (!check) throw new Error(`unknown frame type: ${String(type)}`);

  check(parsed, (why) => {
    throw new Error(`malformed ${String(type)} frame: ${why}`);
  });

  return parsed as unknown as Frame;
}
