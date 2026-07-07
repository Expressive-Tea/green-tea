import { Bus } from './bus';
import { errorToResponse } from './transformers';
import { isAsyncIterable } from './channel';
import type { TransformerFn } from './metadata';

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

/** Type guard narrowing a {@link PipelineResult} to a {@link StreamResult}. */
export function isStreamResult(result: PipelineResult): result is StreamResult {
  return 'stream' in result;
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
}): Promise<PipelineResult> {
  const { steps, handler, transformer, seed, bus } = args;
  // context is intentionally `any`: each step merges arbitrary keys into the accumulator
  let context: any = { ...seed };

  try {
    for (const step of steps) {
      bus.emit('request:step:enter', { name: step.name, scope: step.origin });
      const output = await step.run(context);
      context = { ...context, ...output };
      bus.emit('request:step:leave', { name: step.name, scope: step.origin });
    }

    const result = await handler(context);
    if (isAsyncIterable(result)) return { stream: result }; // stream path: transformer bypassed
    const transformed = transformer(result);
    return { status: transformed.status ?? 200, headers: transformed.headers ?? {}, body: transformed.body };
  } catch (error) {
    bus.emit('request:step:error', { name: 'pipeline', error });
    return errorToResponse(error);
  }
}
