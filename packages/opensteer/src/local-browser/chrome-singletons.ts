import { rm } from "node:fs/promises";
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
