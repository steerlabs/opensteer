import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createBrowserProfileSnapshot } from "../../packages/opensteer/src/local-browser/profile-clone.js";

const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe("browser profile snapshot cloning", () => {
  test("full copy mode preserves profile directories when no specific profile is selected", async () => {
    const sourceUserDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-source-full-"));
    const targetUserDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-target-full-"));
    temporaryDirs.push(sourceUserDataDir, targetUserDataDir);

    await mkdir(path.join(sourceUserDataDir, "Default", "Local Storage"), { recursive: true });
    await writeFile(path.join(sourceUserDataDir, "Local State"), '{"profile":{}}');
    await writeFile(path.join(sourceUserDataDir, "Default", "Preferences"), "{}");
    await writeFile(path.join(sourceUserDataDir, "Default", "Cookies"), "cookies");
    await writeFile(path.join(sourceUserDataDir, "Default", "Local Storage", "leveldb"), "storage");

    await createBrowserProfileSnapshot({
      sourceUserDataDir,
      targetUserDataDir,
      copyMode: "full",
    });

    await expect(
      readFile(path.join(targetUserDataDir, "Default", "Cookies"), "utf8"),
    ).resolves.toBe("cookies");
    await expect(
      readFile(path.join(targetUserDataDir, "Default", "Local Storage", "leveldb"), "utf8"),
    ).resolves.toBe("storage");
  });

  test("session copy mode keeps auth-bearing state and skips volatile caches", async () => {
    const sourceUserDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-source-"));
    const targetUserDataDir = await mkdtemp(path.join(tmpdir(), "opensteer-profile-target-"));
    temporaryDirs.push(sourceUserDataDir, targetUserDataDir);

    await mkdir(path.join(sourceUserDataDir, "Default", "Local Storage"), { recursive: true });
    await mkdir(path.join(sourceUserDataDir, "Default", "IndexedDB"), { recursive: true });
    await mkdir(path.join(sourceUserDataDir, "Default", "Extensions"), { recursive: true });
    await mkdir(path.join(sourceUserDataDir, "Default", "Cache"), { recursive: true });
    await mkdir(path.join(sourceUserDataDir, "Default", "Network"), { recursive: true });

    await writeFile(path.join(sourceUserDataDir, "Local State"), '{"profile":{}}');
    await writeFile(path.join(sourceUserDataDir, "SingletonLock"), "stale");
    await writeFile(path.join(sourceUserDataDir, "Default", "Preferences"), "{}");
    await writeFile(path.join(sourceUserDataDir, "Default", "Cookies"), "cookies");
    await writeFile(
      path.join(sourceUserDataDir, "Default", "Extension Cookies"),
      "extension-cookies",
    );
    await writeFile(path.join(sourceUserDataDir, "Default", "Local Storage", "leveldb"), "storage");
    await writeFile(path.join(sourceUserDataDir, "Default", "IndexedDB", "db"), "indexeddb");
    await writeFile(path.join(sourceUserDataDir, "Default", "Extensions", "manifest.json"), "{}");
    await writeFile(path.join(sourceUserDataDir, "Default", "Cache", "index"), "cache");
    await writeFile(path.join(sourceUserDataDir, "Default", "Network", "index"), "network");

    await createBrowserProfileSnapshot({
      sourceUserDataDir,
      targetUserDataDir,
      profileDirectory: "Default",
      copyMode: "session",
    });

    await expect(readFile(path.join(targetUserDataDir, "Local State"), "utf8")).resolves.toBe(
      '{"profile":{}}',
    );
    await expect(
      readFile(path.join(targetUserDataDir, "Default", "Preferences"), "utf8").then((value) =>
        JSON.parse(value),
      ),
    ).resolves.toEqual({
      profile: {
        exit_type: "Normal",
        exited_cleanly: true,
      },
    });
    await expect(
      readFile(path.join(targetUserDataDir, "Default", "Cookies"), "utf8"),
    ).resolves.toBe("cookies");
    await expect(
      readFile(path.join(targetUserDataDir, "Default", "Extension Cookies"), "utf8"),
    ).resolves.toBe("extension-cookies");
    expect(existsSync(path.join(targetUserDataDir, "Default", "Cache"))).toBe(false);
    expect(existsSync(path.join(targetUserDataDir, "Default", "Network"))).toBe(false);
    expect(existsSync(path.join(targetUserDataDir, "SingletonLock"))).toBe(false);
  });
});
