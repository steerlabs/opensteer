import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { SupervisedProcess } from "@opensteer/harness";
import { supervisedExitCode } from "@opensteer/shared/processControl";
import { EventEmitter } from "node:events";

type Listener =
  ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void);

/**
 * A supervised Claude Code process as the SDK's custom-spawn child. The SDK
 * stops its child with `kill`, which must reach the whole supervised tree: it
 * becomes the supervisor's graceful stop (`SIGKILL` its forced stop) instead
 * of a signal to the supervisor process alone. The exit the SDK sees is the
 * supervisor's, which comes only once the tree is gone, with the target's status.
 */
export function claudeSdkProcess(supervised: SupervisedProcess): SpawnedProcess {
  const { child } = supervised;
  const exits = new EventEmitter();
  void supervised.exited.then(
    ({ code, signal }) => exits.emit("exit", code, signal),
    () => undefined,
  );
  const source = (event: "error" | "exit") => (event === "exit" ? exits : child);
  let killed = false;
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return killed;
    },
    get exitCode() {
      return supervisedExitCode(child.exitCode, process.platform);
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
    on(event: "error" | "exit", listener: Listener) {
      source(event).on(event, listener);
    },
    once(event: "error" | "exit", listener: Listener) {
      source(event).once(event, listener);
    },
    off(event: "error" | "exit", listener: Listener) {
      source(event).off(event, listener);
    },
  };
}
