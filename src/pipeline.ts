import { Bus, type Correlation } from './bus';
import { renderError, type ErrorRenderer } from './transformers';
import { isAsyncIterable } from './channel';
import type { TransformerFn, Transport } from './metadata';
import { TransportMismatchError } from './signals';

/** A single step in a request pipeline: a named unit whose `run` merges its output into the shared context. */
export interface PipelineStep {
  name: string;
  origin: string;
  run: (ctx: any) => any;
}
/** A fully materialized HTTP response produced by a transformer. */
export interface ResponseShape {
  status: number;
  headers: Record<string, string>;
  body: string;
}
/** A streaming response; the async iterable is written to the socket and bypasses the transformer. */
export interface StreamResult {
  stream: AsyncIterable<unknown>;
}
/** The outcome of {@link runPipeline}: either a buffered response or a stream. */
export type PipelineResult = ResponseShape | StreamResult;

/** What a route's declared transport requires its handler to return. */
export type ReturnContract = 'buffer' | 'stream' | 'either';

/** Return contract per transport. A new transport just adds a row. `ws` never reaches runPipeline (filtered earlier). */
export const TRANSPORT_RETURN: Record<Transport, ReturnContract> = {
  buffer: 'buffer',
  sse: 'stream',
  ndjson: 'stream',
  ws: 'stream',
  negotiate: 'either',
};

/** Type guard narrowing a {@link PipelineResult} to a {@link StreamResult}. */
export function isStreamResult(result: PipelineResult): result is StreamResult {
  return 'stream' in result;
}

/**
 * Run `steps` in order, merging each step's output into the context and emitting
 * `request:step:enter`/`leave` on the bus. The single place steps are executed — every
 * transport (HTTP, ws, mesh) goes through here so observability is uniform by construction.
 */
export async function runSteps(
  steps: PipelineStep[],
  seed: Record<string, unknown>,
  bus: Bus,
  correlation: Correlation = {},
): Promise<any> {
  // context is intentionally `any`: each step merges arbitrary keys into the accumulator
  const context: any = seed;
  // One timestamp per boundary, not one pair per step: a step's end is the next one's start, so
  // N steps need N+1 readings rather than 2N. Measured at 25.2ns vs 45.3ns per step, against a
  // ~10.19us request — 0.25%, below the 0.3% run-to-run CV of the project's own benchmark, which
  // is why this is always on instead of hiding behind a flag nobody could tune with evidence.
  let mark = performance.now();

  for (const step of steps) {
    bus.emit('request:step:enter', { name: step.name, scope: step.origin, ...correlation });

    try {
      const output = await step.run(context);
      Object.assign(context, output);
    } catch (error) {
      // Emitted here, where the step that failed is still known. The outer catch in runPipeline
      // only sees "something in the pipeline threw" and used to report `name: 'pipeline'`, which
      // threw away the one fact the event exists to carry. Rethrown unchanged — this observes.
      const now = performance.now();
      bus.emit('request:step:error', {
        name: step.name,
        scope: step.origin,
        error,
        durationMs: now - mark,
        ...correlation,
      });
      throw error;
    }

    const now = performance.now();
    bus.emit('request:step:leave', { name: step.name, scope: step.origin, durationMs: now - mark, ...correlation });
    mark = now;
  }

  return context;
}

/**
 * Run `steps` in order over a context seeded from `seed`, then invoke `handler`.
 * An async-iterable handler result becomes a stream; anything else is run through `transformer`.
 * Errors are caught, emitted on `bus`, and converted to an error response.
 */
export async function runPipeline(args: {
  steps: PipelineStep[];
  handler: (ctx: any) => unknown;
  transformer: TransformerFn;
  seed: Record<string, unknown>;
  bus: Bus;
  transport: Transport;
  onError?: ErrorRenderer;
  correlation?: Correlation;
}): Promise<PipelineResult> {
  const { steps, handler, transformer, seed, bus, transport, onError, correlation = {} } = args;
  // context is intentionally `any`: each step merges arbitrary keys into the accumulator
  let context: any = { ...seed };

  try {
    context = await runSteps(steps, context, bus, correlation);
    const result = await handler(context);
    const streaming = isAsyncIterable(result);
    const contract = TRANSPORT_RETURN[transport];

    if (contract === 'buffer' && streaming) {
      throw new TransportMismatchError(transport, 'stream', context.req as { method?: string; url?: string });
    }

    if (contract === 'stream' && !streaming) {
      throw new TransportMismatchError(transport, 'value', context.req as { method?: string; url?: string });
    }

    if (streaming) return { stream: result }; // stream path: transformer bypassed
    const transformed = transformer(result);
    return { status: transformed.status ?? 200, headers: transformed.headers ?? {}, body: transformed.body };
  } catch (error) {
    // Both fire for a failing step, deliberately: `request:step:error` above marks the span,
    // this marks the trace. A tracing exporter needs each, and only emitting the outer one is
    // what produces a trace that says a request failed without saying where.
    bus.emit('request:failed', { name: correlation.route ?? 'pipeline', error, ...correlation });
    const req = (context.req ?? {}) as { method?: string; url?: string; headers?: Record<string, unknown> };
    return renderError(
      error,
      { method: req.method ?? '', url: req.url ?? '', headers: (context.headers ?? req.headers ?? {}) as never },
      onError,
    );
  }
}
