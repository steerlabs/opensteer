/** Local instrumentation only. No exporter, collector endpoint, or product analytics. */
import { Context, Effect, Schema } from 'effect';
export { captureTelemetry, traceHeaders, withRemoteSpan, invocationFetch, type InvocationTelemetry } from './context.ts';
export { owned, ownedBy, measuredSpan, makeOwnershipAccounting, type SpanMeasure } from './ownership.ts';
export { pendingSpan } from './pending-span.ts';
export const TelemetryBatch = Schema.Struct({ traces: Schema.Array(Schema.String), logs: Schema.Array(Schema.String), dropped: Schema.Number });
export type TelemetryBatch = typeof TelemetryBatch.Type;
export const collectTelemetry = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.map(effect, (value) => ({ value, telemetry: { traces: [], logs: [], dropped: 0 } }));
export const makeTelemetryForwarder = Effect.succeed((_batch: TelemetryBatch, _traceId?: string, _source?: unknown) => Effect.void);

export { externalTrace, currentTraceContext, TraceContext, traceLinks } from './trace-context.ts';
export const CurrentTelemetryConfig = Context.Reference<{ readonly version: string; readonly environment: string } | undefined>('pluginEngine/LocalTelemetryConfig', { defaultValue: () => undefined });
