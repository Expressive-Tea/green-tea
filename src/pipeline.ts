import { Bus } from './bus';
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
export async function runSteps(steps: PipelineStep[], seed: Record<string, unknown>, bus: Bus): Promise<any> {
  // context is intentionally `any`: each step merges arbitrary keys into the accumulator
  const context: any = seed;

  for (const step of steps) {
    bus.emit('request:step:enter', { name: step.name, scope: step.origin });
    const output = await step.run(context);
    Object.assign(context, output);
    bus.emit('request:step:leave', { name: step.name, scope: step.origin });
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
}): Promise<PipelineResult> {
  const { steps, handler, transformer, seed, bus, transport, onError } = args;
  // context is intentionally `any`: each step merges arbitrary keys into the accumulator
  let context: any = { ...seed };

  try {
    context = await runSteps(steps, context, bus);
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
    bus.emit('request:step:error', { name: 'pipeline', error });
    const req = (context.req ?? {}) as { method?: string; url?: string; headers?: Record<string, unknown> };
    return renderError(
      error,
      { method: req.method ?? '', url: req.url ?? '', headers: (context.headers ?? req.headers ?? {}) as never },
      onError,
    );
  }
}
