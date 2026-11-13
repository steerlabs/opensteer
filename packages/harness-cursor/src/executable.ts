import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Cursor's own installer puts the CLI. On macOS and Linux `curl
 * https://cursor.com/install | bash` writes `~/.local/bin/agent`, a symlink
 * into the version directory it keeps updating; on Windows its PowerShell
 * installer puts `agent` on the person's PATH, resolved with PATHEXT at launch.
 *
 * No redistribution grant has been established for this engine, so no
 * distribution ships its bytes and nothing pins its version; the Runner's
 * `OPENSTEER_CURSOR_EXECUTABLE` is optional and this is the default it falls
 * back to. Outside Windows there is no PATH search: a Run must start the
 * engine the person installed under their own account, not whichever `agent`
 * a login shell happens to put first, and the driver reports `unavailable`
 * with the install command when this path holds nothing.
 */
export function installedCursorExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "agent" : join(homedir(), ".local", "bin", "agent");
}
