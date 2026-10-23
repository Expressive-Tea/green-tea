import { compilePattern, matchPattern } from './router';

/**
 * A path the framework answers itself, ahead of the route table, so no declared route may claim it.
 *
 * Each adapter intercepts these before route matching. A user route that could also match one would
 * be served on some code paths and shadowed on others, which is exactly the "works on Node, refused
 * on Deno" split a reserved path exists to prevent, so the boot refuses it instead.
 */
export interface ReservedPath {
  /** The concrete request path, e.g. `/__mesh__/control`. */
  path: string;
  /** What the framework serves there, for the error message (e.g. `the mesh control channel`). */
  purpose: string;
}

/**
 * Returns the reserved path `pattern` would claim, or `undefined` when it claims none.
 *
 * A pattern claims a reserved path when it matches it *and* its first segment is the reserved path's
 * own first segment, spelled literally. The literal-prefix half is deliberate: `/:org/:repo` or a
 * `/:rest*` fallback also match `/__mesh__/control`, but they never ask for it — the adapter intercepts
 * the reserved path before matching, so such a route simply never sees that one path, the same way
 * on every runtime. Refusing them would fail the boot of ordinary apps for a path they never named.
 * A literal pattern is therefore checked by equality and a parameterised one (`/__mesh__/:x`,
 * `/__mesh__/:rest*`) by matching the reserved path against it.
 */
export function claimedReservedPath(pattern: string, reserved: readonly ReservedPath[]): ReservedPath | undefined {
  const first = compilePattern(pattern).segments[0];
  if (first?.kind !== 'static') return undefined;

  return reserved.find(
    (entry) => entry.path.split('/')[1] === first.value && matchPattern(pattern, entry.path) !== undefined,
  );
}

/**
 * Throws when `pattern` claims a reserved path. `subject` names the declaration for the message,
 * e.g. `route GET /__mesh__/control at Chat.control`.
 */
export function assertNotReserved(pattern: string, subject: string, reserved: readonly ReservedPath[]): void {
  const claimed = claimedReservedPath(pattern, reserved);
  if (!claimed) return;

  throw new Error(
    `${subject} uses the reserved path ${claimed.path} (${claimed.purpose}) — ` +
      'green-tea answers that path itself on every runtime, so no route may declare it. Move the route.',
  );
}
