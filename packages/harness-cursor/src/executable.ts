import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Cursor's own installer puts the CLI: `curl https://cursor.com/install
 * | bash` writes `~/.local/bin/agent`, a symlink into the version directory it
 * keeps updating.
 *
 * No redistribution grant has been established for this engine, so no
 * distribution ships its bytes and nothing pins its version; the Runner's
 * `OPENSTEER_CURSOR_EXECUTABLE` is optional and this is the default it falls
 * back to. There is no PATH search: a Run must start the engine the person
 * installed under their own account, not whichever `agent` a login shell
 * happens to put first, and the driver reports `unavailable` with the install
 * command when this path holds nothing.
 */
export function installedCursorExecutable(): string {
  return join(homedir(), ".local", "bin", "agent");
}
