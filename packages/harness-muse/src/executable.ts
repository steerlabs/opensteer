import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The documented per-user location written by Muse Code's installer; on
 * Windows the command its installer puts on PATH, resolved with PATHEXT at launch.
 */
export function installedMuseExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "muse" : join(homedir(), ".local", "bin", "muse");
}
