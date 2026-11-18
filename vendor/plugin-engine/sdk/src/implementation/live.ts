/** Live app queries re-resolve the configured app and its selected accounts on every evaluation. */
import { Schema, Effect, Stream } from "effect";
import type { PluginEngineOptions } from "../contracts/pluginEngine.ts";
import { AppDataInput } from "../contracts/app-data.ts";
import { Json, RequestInvalid } from "../contracts/shared.ts";
import { toEffectRuntime } from "./runtime.ts";
import { createPluginEngine } from "./create.ts";

/** Native host subscription. Hosts must perform their product authorization inside authorize on every run.
 * Calling without authorize is appropriate only for the already-trusted in-process SDK caller.
 */
export const subscribeAppQuery = <E, R>(
  options: PluginEngineOptions,
  input: AppDataInput,
  authorize: Effect.Effect<void, E, R> = Effect.void,
) => {
  const read = Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(AppDataInput)(input).pipe(
      Effect.mapError(() => new RequestInvalid()),
    );
    yield* authorize;
    const pluginEngine = yield* createPluginEngine(options);
    return yield* pluginEngine.appData.query(parsed);
  });
  const runtime = toEffectRuntime(options.runtime, options.blobs);
  if (runtime.changes === undefined) return options.database.reactivity.subscribe(read);
  return Stream.merge(runtime.changes(input.app), Stream.tick("15 seconds")).pipe(
    Stream.mapEffect(() => read),
    Stream.changesWith(Schema.toEquivalence(Json)),
    Stream.zipWithIndex,
    Stream.map(([value, revision]) => ({ value, revision })),
  );
};
