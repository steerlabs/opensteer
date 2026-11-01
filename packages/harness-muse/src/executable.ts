import { homedir } from "node:os";
import { join } from "node:path";

/** The documented per-user location written by Muse Code's installer. */
export function installedMuseExecutable(): string {
  return join(homedir(), ".local", "bin", "muse");
}
