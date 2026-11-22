/** The pool agent's production entry. It carries no test hook of any kind. */
import { log, runDaemon } from "./daemon.js";

runDaemon().catch((error: unknown) => {
  log({ event: "agent.failed", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
