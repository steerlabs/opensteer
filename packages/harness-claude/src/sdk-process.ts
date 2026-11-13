import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { SupervisedProcess } from "@opensteer/harness";

/**
 * A supervised Claude Code process as the SDK's custom-spawn child. The SDK
 * stops its child with `kill`, which must reach the whole supervised tree: it
 * becomes the supervisor's graceful stop (`SIGKILL` its forced stop) instead
 * of a signal to the supervisor process alone. The exit the SDK sees is the
 * supervisor's, which comes only once the tree is gone.
 */
export function claudeSdkProcess(supervised: SupervisedProcess): SpawnedProcess {
  const { child } = supervised;
  let killed = false;
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill(signal) {
      killed = true;
      // A failed control write means the supervisor is already gone, and its
      // closed control pipe has already ended the tree.
      void supervised.terminate(signal === "SIGKILL" ? 0 : undefined).catch(() => undefined);
      return true;
    },
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  };
}
