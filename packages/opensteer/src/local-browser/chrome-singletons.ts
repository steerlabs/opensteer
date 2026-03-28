import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CHROME_SINGLETON_ARTIFACTS = [
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "DevToolsActivePort",
  "lockfile",
] as const;

export type ChromeSingletonArtifact = (typeof CHROME_SINGLETON_ARTIFACTS)[number];

export async function clearChromeSingletonEntries(userDataDir: string): Promise<void> {
  await Promise.all(
    CHROME_SINGLETON_ARTIFACTS.map((entry) =>
      rm(join(userDataDir, entry), {
        recursive: true,
        force: true,
      }).catch(() => undefined),
    ),
  );
}

/**
 * Fix Chrome profile state so the browser does not show "something is wrong
 * with the profile" on the next launch.
 *
 * Chrome writes `exit_type: "Crashed"` (or leaves it empty) in the
 * per-profile `Preferences` file when it does not shut down cleanly.  On the
 * next launch it detects this and shows a recovery/error dialog.  For cloned
 * profiles the problem is even more common because the source browser was
 * still running when the copy was made.
 *
 * We reset `exit_type` to `"Normal"` and `exited_cleanly` to `true`.
 * Because Chrome also validates the HMAC stored in `Secure Preferences`, we
 * remove that file so Chrome regenerates it from the corrected Preferences.
 */
export async function sanitizeChromeProfile(userDataDir: string): Promise<void> {
  const entries = await readdir(userDataDir).catch(() => []);
  const profileDirs = entries.filter(
    (entry) => entry === "Default" || /^Profile \d+$/i.test(entry),
  );

  await Promise.all(profileDirs.map((dir) => sanitizeProfilePreferences(userDataDir, dir)));
}

async function sanitizeProfilePreferences(userDataDir: string, profileDir: string): Promise<void> {
  const prefsPath = join(userDataDir, profileDir, "Preferences");
  try {
    const raw = await readFile(prefsPath, "utf8");
    const prefs = JSON.parse(raw) as Record<string, unknown>;
    const profile = (prefs.profile ?? {}) as Record<string, unknown>;

    if (profile.exit_type === "Normal" && profile.exited_cleanly === true) {
      return;
    }

    profile.exit_type = "Normal";
    profile.exited_cleanly = true;
    prefs.profile = profile;
    await writeFile(prefsPath, JSON.stringify(prefs), "utf8");

    // Remove Secure Preferences — its HMAC no longer matches the modified
    // Preferences file.  Chrome will silently regenerate it on startup.
    await rm(join(userDataDir, profileDir, "Secure Preferences"), { force: true }).catch(
      () => undefined,
    );
  } catch {
    // Preferences file may be missing or malformed — skip silently.
  }
}
