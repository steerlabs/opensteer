import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessRuntimeExpectedVersion, shippedHarnessKinds } from "@opensteer/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessDriverFactories } from "./harness-drivers.js";
import { harnessRuntimeArtifactVersionMismatches } from "./verify-harness-runtimes.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("harness runtime verification", () => {
  it("finds every resolved engine artifact at exactly the catalog's pin without executing it", async () => {
    await expect(harnessRuntimeArtifactVersionMismatches()).resolves.toEqual([]);
  });

  it.each(shippedHarnessKinds)(
    "reports a mismatched %s artifact at the Runner's resolved path",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "opensteer-runtime-pin-"));
      directories.push(directory);
      const executable = join(directory, "bin", "engine");
      await mkdir(join(directory, "bin"));
      // These files cannot run. Verification must read metadata, even for native engines.
      await writeFile(executable, "not an executable");
      const packages = {
        codex: { name: "@openai/codex", version: `9.8.7-${process.platform}-${process.arch}` },
        opencode: {
          name: `opencode-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
          version: "9.8.7",
        },
        pi: { name: "@earendil-works/pi-coding-agent", version: "9.8.7" },
      };
      await writeFile(join(directory, "package.json"), JSON.stringify(packages[kind]));
      vi.spyOn(harnessDriverFactories[kind], "defaultExecutable").mockReturnValue(executable);
      await expect(harnessRuntimeArtifactVersionMismatches()).resolves.toEqual([
        {
          kind,
          executable,
          expected: harnessRuntimeExpectedVersion(kind),
          actual: kind === "codex" ? "codex-cli 9.8.7" : "9.8.7",
        },
      ]);
    },
  );

  it("fails clearly when the Runner resolves a missing engine", async () => {
    vi.spyOn(harnessDriverFactories.codex, "defaultExecutable").mockReturnValue(
      "/missing/opensteer-engine-pin/codex",
    );
    await expect(harnessRuntimeArtifactVersionMismatches()).rejects.toThrow(
      /codex.*\/missing\/opensteer-engine-pin\/codex/u,
    );
  });

  it("rejects Codex metadata for another platform instead of stripping an arbitrary suffix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-codex-pin-"));
    directories.push(directory);
    const executable = join(directory, "codex");
    await writeFile(executable, "not an executable");
    await writeFile(
      join(directory, "package.json"),
      '{"name":"@openai/codex","version":"0.162.0-other-platform"}',
    );
    vi.spyOn(harnessDriverFactories.codex, "defaultExecutable").mockReturnValue(executable);
    await expect(harnessRuntimeArtifactVersionMismatches()).rejects.toThrow(/codex.*platform/u);
  });

  it("names an engine whose executable cannot be resolved", async () => {
    vi.spyOn(harnessDriverFactories.opencode, "defaultExecutable").mockImplementation(() => {
      throw new Error("platform package missing");
    });
    await expect(harnessRuntimeArtifactVersionMismatches()).rejects.toThrow(
      /opencode.*platform package missing/u,
    );
  });
});
