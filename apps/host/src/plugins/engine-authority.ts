import { Cause, Context, Effect, Exit } from "effect";
import type { PluginCaller } from "./engine-protocol.js";

export const CurrentPluginRequest = Context.Reference<
  { context: PluginCaller; operation: string; plugin?: string; execution?: string } | undefined
>("opensteer/PluginRequest", { defaultValue: () => undefined });

/**
 * Why a dispatch refused the build it was asked to run: the build is not one the runtime runs as it
 * is, and its plugin waits for a rebuild of its source (`updating`), or no rebuild will make it
 * run (`stale`).
 */
export type DispatchRefusal =
  { readonly kind: "updating"; readonly reason: string } | { readonly kind: "stale" };

/** Where a dispatch notes its refusal for the request that reached it; see `noticingRefusal`. */
export const DispatchRefusals = Context.Reference<{ refusal?: DispatchRefusal } | undefined>(
  "opensteer/DispatchRefusals",
  { defaultValue: () => undefined },
);

/**
 * Run `work`, with how it ended and the refusal of any dispatch it reached. Within a request that
 * already notices refusals the request's own record is shared, so an outer answer sees what an
 * inner one answered.
 */
export const noticingRefusal = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.flatMap(DispatchRefusals, (outer) => {
    const cell: { refusal?: DispatchRefusal } = outer ?? {};
    return work.pipe(
      Effect.provideService(DispatchRefusals, cell),
      Effect.exit,
      Effect.map((exit) => ({ exit, refusal: cell.refusal })),
    );
  });

/** Run `work`; a failure that a dispatch's refusal caused is answered by `answer` instead. */
export const answeringRefusal = <A, E, R, B, E2>(
  work: Effect.Effect<A, E, R>,
  answer: (refusal: DispatchRefusal) => Effect.Effect<B, E2>,
): Effect.Effect<A | B, E | E2, R> =>
  noticingRefusal(work).pipe(
    Effect.flatMap(
      ({ exit, refusal }): Effect.Effect<A | B, E | E2> =>
        Exit.isSuccess(exit) || refusal === undefined || !Cause.hasFails(exit.cause)
          ? exit
          : answer(refusal),
    ),
  );
