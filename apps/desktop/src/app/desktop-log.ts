import path from "node:path";
import { RotatingPersonalLog } from "../supervisor/personal-process-port.js";

/**
 * The desktop app's own log, `logs/desktop.log` in its data folder, opened with what the app
 * ignored from its environment written first: a released app is opened from the Dock, where no one
 * reads its stdout, so a note that reaches only stdout reaches no one.
 */
export function openDesktopLog(
  dataDirectory: string,
  ignored: readonly { readonly name: string; readonly reason: string }[],
): RotatingPersonalLog {
  const log = new RotatingPersonalLog(path.join(dataDirectory, "logs", "desktop.log"));
  for (const value of ignored) {
    const line = JSON.stringify({ event: "desktop.environment.ignored", ...value });
    process.stdout.write(`${line}\n`);
    log.append("stdout", line);
  }
  return log;
}
