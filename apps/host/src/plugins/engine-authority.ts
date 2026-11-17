import { AppCodeEntered, RuntimeProtocolFailed } from "@opensteer/plugin-engine-sdk/core";
import { Context, Effect } from "effect";
import {
  PluginServiceError,
  type PluginAuthorization,
  type PluginAuthorizationResult,
  type PluginCaller,
} from "./engine-protocol.js";
export const CurrentPluginRequest = Context.Reference<
  { context: PluginCaller; operation: string; plugin?: string; execution?: string } | undefined
>("opensteer/PluginRequest", { defaultValue: () => undefined });
export function engineAdmission<A, E, R>(
  authorize: (input: PluginAuthorization) => Effect.Effect<PluginAuthorizationResult, Error>,
  input: PluginAuthorization,
  work: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const entered = yield* AppCodeEntered;
    let releasing: Promise<unknown> | undefined;
    const release = (lease: string | undefined) => {
      if (lease && !releasing) {
        releasing = Effect.runPromise(authorize({ ...input, admission: false, lease }));
        void releasing.catch(() => undefined);
      }
      return releasing ?? Promise.resolve();
    };
    return yield* Effect.acquireUseRelease(
      authorize({ ...input, admission: true }).pipe(
        Effect.flatMap((permission) =>
          permission.allowed
            ? Effect.succeed(permission)
            : Effect.fail(
                new PluginServiceError("forbidden", "Plugin authority changed before dispatch"),
              ),
        ),
        Effect.mapError(() => new RuntimeProtocolFailed({ reason: "unrecognized" })),
      ),
      (permission) =>
        work.pipe(
          Effect.provideService(AppCodeEntered, {
            entered: () => {
              entered.entered();
              void release(permission.lease);
            },
          }),
        ),
      (permission) => Effect.promise(() => release(permission.lease)),
    );
  });
}
