/**
 * How the integration suite's lock-order checker observes PostgreSQL row locks.
 * `off` (the default) observes no lock order but still fails on deadlocks and
 * serialization failures; `enforce`, which the full integration run sets, also fails
 * on violations and cycles; `record` keeps every acquisition without failing, for
 * diagnosis only. See docs/testing.md#lock-order-modes.
 */
export type LockOrderMode = "enforce" | "record" | "off";

export const lockOrderModeVariable = "OPENSTEER_LOCK_ORDER_MODE";

export function lockOrderMode(environment: NodeJS.ProcessEnv = process.env): LockOrderMode {
  const mode = environment[lockOrderModeVariable] ?? "off";
  if (mode === "enforce" || mode === "record" || mode === "off") return mode;
  throw new Error(
    `${lockOrderModeVariable} must be enforce, record or off, not ${JSON.stringify(mode)}`,
  );
}
