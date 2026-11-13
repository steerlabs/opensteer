import type { Writable } from "node:stream";

/** Desktop supplies the verified native owner to every supervised Node child. */
export const processSupervisorExecutableVariable = "OPENSTEER_PROCESS_SUPERVISOR_EXECUTABLE";

/**
 * The signals that ask a service to shut down gracefully. The supervisor stops
 * a Windows child with CTRL_BREAK, which Node delivers as SIGBREAK.
 */
export const shutdownSignals = ["SIGINT", "SIGBREAK", "SIGTERM"] as const;

/**
 * The Windows supervisor's status when it ended its Job without proving every
 * member finished terminating. Every other status it exits with means the tree is gone.
 */
export const processSupervisorUndrainedExitCode = 256;

/** A child's own stop budgets derive from this, so none can outlast the supervisor's kill. */
export const processStopTimeoutMs = 5_000;

export function writeProcessControl(
  control: Pick<Writable, "write">,
  mode: "force" | "graceful",
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    control.write(`${mode}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
