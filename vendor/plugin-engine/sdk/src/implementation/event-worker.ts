/** A Node host delivers due events in its own scope, waking every few seconds. */
import { Effect, Schedule } from "effect";
import { traceFailure } from "@opensteer/plugin-engine-telemetry/failed-span";
import type { PluginEngine } from "../contracts/pluginEngine.ts";
import { ScheduleHostReady } from "../contracts/schedule-worker.ts";

/** Deliveries per pass; a full pass runs again at once. */
const batch = 32;

/** Run until the scope closes. Each emit also attempts its deliveries at once. */
export const deliverEvents = (pluginEngine: PluginEngine) =>
  Effect.gen(function* () {
    yield* Effect.flatten(ScheduleHostReady);
    yield* pluginEngine.events.deliver({ maxDeliveries: batch }).pipe(
      Effect.repeat({ while: (more) => more }),
      // A pass runs every two seconds; one that finds nothing to deliver records nothing. One
      // that fails is still a trace of its own.
      Effect.withTracerEnabled(false),
      traceFailure("events.dispatch"),
      Effect.catch(() => Effect.logError("Event delivery failed")),
      Effect.repeat(Schedule.spaced("2 seconds")),
    );
  });
