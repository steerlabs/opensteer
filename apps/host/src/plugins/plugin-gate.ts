/**
 * Per plugin, within the one engine process that owns its runtime directory (see
 * `engine-ownership.ts`): a readers–writer gate. Executions share it; a change of which version is
 * active holds it alone, so no build of the plugin runs while its database migrates and the new
 * version is activated. A change that waits stops new executions from starting ahead of it, and
 * waits a bounded time for the ones already running. Nothing here touches PostgreSQL, so one
 * plugin's changes never wait on another's.
 */
import { Context, Data, Effect, Semaphore } from "effect";

/**
 * How long a version change waits for its plugin's running executions to finish. An ordinary tool
 * call, step or delivery finishes in seconds, and an owner waits on the change; an execution that
 * runs longer is usually waiting on a person's answer, which can take a day. Ten seconds lets the
 * first kind finish, and then the change gives up with "busy", having changed nothing.
 */
export const drainMs = 10_000;

/** The plugin's executions did not finish within `drainMs`; nothing of the change happened. */
export class PluginBusy extends Data.TaggedError("PluginBusy")<{ readonly plugin: string }> {}

/**
 * The plugins whose execution this fiber already holds. Work an execution starts in the same
 * plugin, such as a step a tool starts, runs within it rather than waiting behind a change that
 * waits for the execution itself.
 */
const Leases = Context.Reference<ReadonlySet<string>>("opensteer/PluginLeases", {
  defaultValue: () => new Set(),
});

/**
 * Executions that never wait for a change, such as the owner's settings evaluating a plugin's
 * declarations: while a change waits or holds the plugin they fail at once with `PluginBusy`.
 */
export const Impatient = Context.Reference<boolean>("opensteer/PluginImpatient", {
  defaultValue: () => false,
});

interface State {
  /** Executions that hold the gate. */
  readers: number;
  /** A change waits for them, or holds the gate: no new execution starts. */
  changing: boolean;
  readonly changes: Semaphore.Semaphore;
  readonly wakers: Set<() => void>;
}

export type PluginGate = ReturnType<typeof pluginGate>;

export const pluginGate = (wait = drainMs) => {
  const plugins = new Map<string, State>();
  const of = (plugin: string) => {
    let state = plugins.get(plugin);
    if (state === undefined) {
      state = { readers: 0, changing: false, changes: Semaphore.makeUnsafe(1), wakers: new Set() };
      plugins.set(plugin, state);
    }
    return state;
  };
  const wake = (state: State) => {
    for (const waker of state.wakers) waker();
  };
  /**
   * Wait until `ready` holds, then apply `take` in the same synchronous step, so no other waiter
   * runs between the check and the change. An interrupted waiter that had taken gives it back.
   */
  const when = (state: State, ready: () => boolean, take: () => void, give: () => void) =>
    Effect.callback<void>((resume) => {
      if (ready()) {
        take();
        resume(Effect.void);
        return;
      }
      let taken = false;
      const waker = () => {
        if (taken || !ready()) return;
        taken = true;
        state.wakers.delete(waker);
        take();
        resume(Effect.void);
      };
      state.wakers.add(waker);
      return Effect.sync(() => {
        state.wakers.delete(waker);
        if (taken) give();
      });
    });
  const enter = (state: State) =>
    when(
      state,
      () => !state.changing,
      () => {
        state.readers += 1;
      },
      () => leave(state),
    );
  const leave = (state: State) => {
    state.readers -= 1;
    wake(state);
  };
  return {
    /** Whether a change of the plugin waits for its executions or holds it. */
    changing: (plugin: string) => plugins.get(plugin)?.changing === true,
    /**
     * Run `work`, one execution of the plugin. It waits while a change of the plugin waits or
     * holds it, so a change is never overtaken; work it starts in the same plugin runs at once.
     */
    run: <A, E, R>(
      plugin: string,
      work: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | PluginBusy, R> =>
      Effect.flatMap(
        Effect.all([Leases, Impatient]),
        ([held, impatient]): Effect.Effect<A, E | PluginBusy, R> => {
          if (held.has(plugin)) return work;
          const state = of(plugin);
          if (impatient && state.changing) return Effect.fail(new PluginBusy({ plugin }));
          return Effect.acquireUseRelease(
            enter(state),
            () => work.pipe(Effect.provideService(Leases, new Set([...held, plugin]))),
            () => Effect.sync(() => leave(state)),
          );
        },
      ),
    /**
     * Run `work`, a change of the plugin's active version, holding the plugin alone. Changes of
     * one plugin run one at a time. Once its turn comes, no new execution starts; if the running
     * ones have not finished within the wait, it fails with `PluginBusy` and `work` never ran.
     */
    change: <A, E, R>(
      plugin: string,
      work: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | PluginBusy, R> => {
      const state = of(plugin);
      return state.changes.withPermits(1)(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            state.changing = true;
          }),
          () =>
            Effect.callback<boolean>((resume) => {
              if (state.readers === 0) return resume(Effect.succeed(true));
              const waker = () => {
                if (state.readers !== 0) return;
                state.wakers.delete(waker);
                resume(Effect.succeed(true));
              };
              state.wakers.add(waker);
              return Effect.sync(() => {
                state.wakers.delete(waker);
              });
            }).pipe(
              Effect.timeoutOption(wait),
              Effect.flatMap((drained): Effect.Effect<A, E | PluginBusy, R> =>
                drained._tag === "Some" ? work : Effect.fail(new PluginBusy({ plugin })),
              ),
            ),
          () =>
            Effect.sync(() => {
              state.changing = false;
              wake(state);
            }),
        ),
      );
    },
  };
};
