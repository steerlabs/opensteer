/**
 * Per plugin, within the one engine process that owns the database (see `engine-ownership.ts`):
 * one change of which version is active at a time, and a hold of the plugin's execution while a
 * change commits, so the build that was active never runs against a database its successor
 * migrated. Nothing here touches PostgreSQL, so one plugin's changes never wait on another's.
 */
import { Effect, Semaphore } from "effect";

/** More executions of one plugin than ever run at once; a hold takes them all. */
const capacity = 1_000_000;

export type PluginGate = ReturnType<typeof pluginGate>;

export const pluginGate = () => {
  const plugins = new Map<
    string,
    { readonly changes: Semaphore.Semaphore; readonly execution: Semaphore.Semaphore }
  >();
  const of = (plugin: string) => {
    let gate = plugins.get(plugin);
    if (gate === undefined) {
      gate = { changes: Semaphore.makeUnsafe(1), execution: Semaphore.makeUnsafe(capacity) };
      plugins.set(plugin, gate);
    }
    return gate;
  };
  return {
    /** Run `work`, a change of the plugin's active version, as the only one of the plugin. */
    change: <A, E, R>(plugin: string, work: Effect.Effect<A, E, R>) =>
      of(plugin).changes.withPermits(1)(work),
    /**
     * Run `work` with the plugin's execution held: once what already runs of it has finished, and
     * with nothing new of it admitted until `work` ends. Executions that start meanwhile go first,
     * so one that starts another of the same plugin never waits on itself.
     */
    hold: <A, E, R>(plugin: string, work: Effect.Effect<A, E, R>) =>
      of(plugin).execution.withPermits(capacity)(work),
    /** Run one execution of the plugin, waiting while it is held. */
    run: <A, E, R>(plugin: string, work: Effect.Effect<A, E, R>) =>
      of(plugin).execution.withPermits(1)(work),
  };
};
