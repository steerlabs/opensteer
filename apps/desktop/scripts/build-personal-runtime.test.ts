import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bundleNodeService } from "./build-personal-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("bundleNodeService", () => {
  it("keeps the page globals Browser Harness sends into pages", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opensteer-harness-bundle-"));
    temporaryDirectories.push(directory);
    const script = path.join(directory, "browser-harness.mjs");
    await bundleNodeService(
      script,
      "browser-harness",
      fileURLToPath(new URL("../../runner/browser-harness/browser-harness.mjs", import.meta.url)),
    );
    // Functions sent into a page run against its own globals; a bundler that
    // renames a same-named local makes them throw there (`document2 is not defined`).
    expect(
      (await readFile(script, "utf8")).match(/\b(?:document|window|location)\d+\b/gu),
    ).toBeNull();
  });
});
