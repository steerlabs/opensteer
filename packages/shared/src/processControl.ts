import type { Writable } from "node:stream";

/** Desktop supplies the verified native owner to every supervised Node child. */
export const processSupervisorExecutableVariable = "OPENSTEER_PROCESS_SUPERVISOR_EXECUTABLE";

/**
 * The signals that ask a service to shut down gracefully. The supervisor stops
 * a Windows child with CTRL_BREAK, which Node delivers as SIGBREAK.
 */
export const shutdownSignals = ["SIGINT", "SIGBREAK", "SIGTERM"] as const;

/**
 * The Windows supervisor adds this to its target's 0-255 status only once it
 * saw its Job drain. Any other status, such as 256 (it gave up draining) or 1
 * (it was killed from outside), proves nothing about the tree. The supervisor's
 * drainedExitTag holds the same value.
 */
const windowsDrainedExitTag = 0x2f53_0000;

/** Whether a Windows supervisor's exit code is its own proof that its whole tree is gone. */
export function windowsSupervisorDrained(code: number | null): boolean {
  return code !== null && code >= windowsDrainedExitTag && code <= windowsDrainedExitTag + 0xff;
}

/** The target's own status out of a supervisor's exit code; one without the drained tag is passed through. */
export function supervisedExitCode(code: number | null, platform: NodeJS.Platform): number | null {
  if (platform !== "win32" || code === null || !windowsSupervisorDrained(code)) return code;
  return code - windowsDrainedExitTag;
}

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
