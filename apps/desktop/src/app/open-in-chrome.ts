import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DesktopOpenInChromeResult } from "@opensteer/protocol/desktop";

const execute = promisify(execFile);

/** Google Chrome, by the identity macOS knows it by, wherever it is installed. */
export const chromeBundleIdentifier = "com.google.Chrome";

export type OpenCommand = (file: string, args: readonly string[]) => Promise<unknown>;

/**
 * Opens a page in Google Chrome itself, not the default browser: connecting Chrome works only
 * from inside Chrome. macOS finds Chrome by its bundle identifier; when it can't, Chrome isn't
 * installed, and that is said rather than opening the page somewhere it can't work.
 */
export async function openInChrome(
  url: string,
  run: OpenCommand = (file, args) => execute(file, [...args]),
): Promise<DesktopOpenInChromeResult> {
  try {
    await run("/usr/bin/open", ["-b", chromeBundleIdentifier, url]);
    return { opened: true };
  } catch {
    return { opened: false, reason: "chrome-not-installed" };
  }
}
