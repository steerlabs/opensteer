import type { Writable } from "node:stream";

/** Desktop supplies the verified native owner to every supervised Node child. */
export const processSupervisorExecutableVariable = "OPENSTEER_PROCESS_SUPERVISOR_EXECUTABLE";

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
