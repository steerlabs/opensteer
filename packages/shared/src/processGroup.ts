/** Stopping a command started as the leader of its own process group (`detached` on POSIX). */
import { setTimeout as delay } from "node:timers/promises";
import { isNodeError } from "./nodeError.js";

/**
 * Signals every process in `group`. Darwin answers EPERM while the group holds
 * only a child not yet reaped (a zombie), or a member under another uid.
 */
function signalGroup(
  group: number,
  signal: NodeJS.Signals | 0,
): "present" | "unsignalable" | "gone" {
  try {
    process.kill(-group, signal);
    return "present";
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return "gone";
    if (isNodeError(error) && error.code === "EPERM") return "unsignalable";
    throw error;
  }
}

/**
 * Sends `signal` to every process in `group`, SIGKILL after `graceMs`, and
 * keeps killing until none is left, so nothing the command started meanwhile
 * survives. Resolves only then: a caller that releases a lock afterwards
 * leaves no process of its own writing under it. Members it may not signal are
 * waited for `reapMs` past the SIGKILL deadline (a zombie is reaped by then),
 * then it throws rather than hold its caller's locks forever.
 */
export async function stopProcessGroup(
  group: number,
  options: {
    readonly signal?: NodeJS.Signals;
    readonly graceMs?: number;
    readonly reapMs?: number;
  } = {},
): Promise<void> {
  const deadline = performance.now() + (options.graceMs ?? 5_000);
  let state = signalGroup(group, options.signal ?? "SIGTERM");
  while (state !== "gone") {
    if (state === "unsignalable" && performance.now() > deadline + (options.reapMs ?? 10_000))
      throw new Error(
        `Process group ${group} still has members this process may not signal (EPERM)`,
      );
    await delay(50);
    state = signalGroup(group, performance.now() < deadline ? 0 : "SIGKILL");
  }
}
