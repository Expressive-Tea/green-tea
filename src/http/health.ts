import type { ReservedPath } from './reserved-paths';

/** Liveness probe path: `200` whenever the process answers. */
export const LIVE_PATH = '/__live__';
/** Readiness probe path: `503` while booting or draining, `200` otherwise. */
export const READY_PATH = '/__ready__';

/** The probe paths, as reserved-path entries for the boot check (only while `health` is on). */
export const HEALTH_RESERVED: readonly ReservedPath[] = [
  { path: LIVE_PATH, purpose: 'the liveness probe, health: true' },
  { path: READY_PATH, purpose: 'the readiness probe, health: true' },
];

/**
 * Where an app is in its life, as `/__ready__` reports it.
 *
 * `booting` until `boot()` resolves, `ready` after, `draining` from the moment `close()` starts.
 * Moves forward only: a boot that finishes while draining does not make the app ready again.
 */
export type HealthPhase = 'booting' | 'ready' | 'draining';

/** What the adapters read to answer a probe. Lives on {@link HttpOptions}; absent when `health` is off. */
export interface HealthProbe {
  phase(): HealthPhase;
  /** Optional providers that failed to boot, as `app.degraded()` reports them. */
  degraded(): string[];
}

/**
 * Close-time hook on the app object for the adapters that own the server (`serveDeno`, `serveBun`):
 * marks the app draining and resolves after `drainDelayMs`, so the listener stays open while
 * `/__ready__` answers `503`. Idempotent — later calls share the first window. Symbol-keyed because it
 * is adapter plumbing, not public API.
 */
export const HEALTH_DRAIN: unique symbol = Symbol.for('green-tea.health-drain');

/** Starts the drain window on `app` (see {@link HEALTH_DRAIN}); resolves at once when health is off. */
export function beginDrain(app: object): Promise<void> {
  return (app as { [HEALTH_DRAIN]?: () => Promise<void> })[HEALTH_DRAIN]?.() ?? Promise.resolve();
}

/** A probe response, before the adapter merges in the injected security headers. */
export interface ProbeAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_NO_STORE = { 'content-type': 'application/json', 'cache-control': 'no-store' };

/** The readiness body and status for the current phase. */
function readiness(probe: HealthProbe): { status: number; body: object } {
  const phase = probe.phase();
  if (phase === 'booting') return { status: 503, body: { status: 'booting' } };
  if (phase === 'draining') return { status: 503, body: { status: 'draining' } };

  const degraded = probe.degraded();
  return degraded.length
    ? { status: 200, body: { status: 'degraded', degraded } }
    : { status: 200, body: { status: 'ok' } };
}

/**
 * Answers `/__live__` or `/__ready__`, or returns `undefined` for any other path.
 *
 * Called by each adapter before the request gate and before `handle()`, so a probe runs no step,
 * provider, plugin or `onError`, emits no lifecycle event, and is never shed by
 * `maxConcurrentRequests`. `url` may carry a query string; only the exact path is a probe.
 */
export function answerProbe(method: string, url: string, probe: HealthProbe): ProbeAnswer | undefined {
  const query = url.indexOf('?');
  const path = query === -1 ? url : url.slice(0, query);
  if (path !== LIVE_PATH && path !== READY_PATH) return undefined;

  if (method !== 'GET' && method !== 'HEAD') {
    return {
      status: 405,
      headers: { ...JSON_NO_STORE, allow: 'GET, HEAD' },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  const { status, body } = path === LIVE_PATH ? { status: 200, body: { status: 'ok' } } : readiness(probe);
  return { status, headers: { ...JSON_NO_STORE }, body: method === 'HEAD' ? '' : JSON.stringify(body) };
}

/** `createApp({ health })`, normalised. `undefined` when health is off. */
export interface HealthConfig {
  drainDelayMs: number;
}

/**
 * Validates `createApp({ health })` and normalises it. Throws on anything but `true`, `false`,
 * `undefined` or `{ drainDelayMs?: number }`, and on a `drainDelayMs` that does not fit in the shutdown
 * budget next to the teardown reservation.
 */
export function resolveHealth(
  health: unknown,
  shutdownTimeoutMs: number | undefined,
  teardownTimeoutMs: number | undefined,
): HealthConfig | undefined {
  if (health === undefined || health === false) return undefined;
  if (health === true) return { drainDelayMs: 0 };

  if (typeof health !== 'object' || health === null || Array.isArray(health)) {
    throw new Error(`health must be true, false or { drainDelayMs?: number } — got ${JSON.stringify(health)}`);
  }

  const unknown = Object.keys(health).filter((key) => key !== 'drainDelayMs');

  if (unknown.length) {
    throw new Error(
      `health: unknown option ${unknown.map((key) => `'${key}'`).join(', ')} — only drainDelayMs is supported`,
    );
  }

  const drainDelayMs = (health as { drainDelayMs?: unknown }).drainDelayMs ?? 0;

  if (typeof drainDelayMs !== 'number' || !Number.isFinite(drainDelayMs) || drainDelayMs < 0) {
    throw new Error(`health.drainDelayMs must be a non-negative number of milliseconds — got ${String(drainDelayMs)}`);
  }

  const budget = shutdownTimeoutMs ?? 10_000;
  const reserved = teardownTimeoutMs ?? 0;

  if (drainDelayMs + reserved > budget) {
    throw new Error(
      `health.drainDelayMs (${drainDelayMs}) plus teardownTimeoutMs (${reserved}) cannot exceed ` +
        `shutdownTimeoutMs (${budget}) — the drain window is spent out of the shutdown budget, ` +
        'so close() would have no time left to drain connections or run teardown.',
    );
  }

  return { drainDelayMs };
}

/**
 * The health state machine for one app: wraps `bootGraph` so a resolved boot marks it ready, and
 * offers the drain that `close()` (and `serveDeno`/`serveBun` through {@link HEALTH_DRAIN}) starts.
 * With health off the probe is absent and the drain resolves at once.
 */
export function trackHealth(
  health: HealthConfig | undefined,
  bootGraph: () => Promise<void>,
  degraded: () => string[],
): { bootApp: () => Promise<void>; healthProbe: HealthProbe | undefined; drain: () => Promise<void> } {
  // Forward only: a boot that resolves after close() started stays draining.
  let phase: HealthPhase = 'booting';
  // Shared by every drain call. Left referenced on purpose: the process must stay up for the window.
  let drainWindow: Promise<void> | undefined;

  const bootApp = async (): Promise<void> => {
    await bootGraph();
    if (phase === 'booting') phase = 'ready';
  };

  const drain = (): Promise<void> => {
    if (!health) return Promise.resolve();

    if (!drainWindow) {
      phase = 'draining';
      const ms = health.drainDelayMs;
      drainWindow = ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
    }

    return drainWindow;
  };

  return { bootApp, healthProbe: health ? { phase: () => phase, degraded } : undefined, drain };
}
