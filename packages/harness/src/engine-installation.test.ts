import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareRevisionVersions,
  EngineInstallationResolver,
  parseBrewLatestVersion,
  parseNpmLatestVersion,
  type InstalledEngineUpdateFacts,
} from "./engine-installation.js";

const roots: string[] = [];
const codex: InstalledEngineUpdateFacts = {
  executableName: "Codex",
  homebrew: { cask: "codex" },
  minimumVersion: "0.156.0",
  native: { realPathIncludes: ["/.codex/packages/standalone/"], updateArgs: ["update"] },
  packageName: "@openai/codex",
  version: { args: ["--version"], pattern: /codex-cli\s+(\d+\.\d+\.\d+)/ },
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("EngineInstallationResolver", () => {
  it.each([
    {
      name: "native self-updater",
      path: ".codex/packages/standalone/releases/0.160.0/bin/codex",
      expected: ["update"],
      managers: ["npm"],
    },
    {
      name: "npm global",
      path: "npm-prefix/lib/node_modules/@openai/codex/bin/codex",
      expected: ["install", "--global", "@openai/codex@latest"],
      managers: ["npm"],
    },
    {
      name: "pnpm global pins the fetched release",
      path: ".local/share/pnpm/global/5/node_modules/@openai/codex/bin/codex",
      expected: ["add", "--global", "@openai/codex@0.166.0"],
      managers: ["pnpm", "npm"],
    },
    {
      name: "Homebrew cask",
      path: "brew/Caskroom/codex/0.160.0/bin/codex",
      expected: ["upgrade", "--cask", "codex"],
      managers: ["brew"],
    },
    {
      name: "npm package beneath a Homebrew Node formula is npm-owned",
      path: "brew/Cellar/node/24.0.0/lib/node_modules/@openai/codex/bin/codex",
      expected: ["install", "--global", "@openai/codex@latest"],
      managers: ["npm", "brew"],
      npmPrefix: "brew/Cellar/node/24.0.0",
    },
  ])("detects $name", async ({ path, expected, managers, npmPrefix }) => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-engine-installation-"));
    roots.push(root);
    const executable = join(root, path);
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, "binary");
    await chmod(executable, 0o755);
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const manager of managers) {
      const managerPath =
        manager === "brew" ? join(root, "brew", "bin", "brew") : join(bin, manager);
      await mkdir(join(managerPath, ".."), { recursive: true });
      await writeFile(managerPath, "#!/bin/sh\n");
      await chmod(managerPath, 0o755);
    }
    const resolver = new EngineInstallationResolver({
      environment: { PATH: `${bin}:${join(root, "brew", "bin")}` },
      run: async (_command, args) => {
        if (args[0] === "--version") return result("codex-cli 0.160.0");
        if (args[0] === "prefix") return result(join(root, npmPrefix ?? "npm-prefix"));
        if (args[0] === "view") return result('"0.166.0"');
        if (args[0] === "info") return result('{"casks":[{"version":"0.166.0"}],"formulae":[]}');
        if (args[0] === "--prefix") return result(join(root, "brew"));
        return result("");
      },
    });
    const resolved = await resolver.resolve(executable, codex, "ambient");
    expect(resolved.plan?.args).toEqual(expected);
    expect(resolved.descriptor).toMatchObject({
      latestVersion: "0.166.0",
      update: "available",
      version: "0.160.0",
    });
  });

  it("leaves mise ownership manual instead of inventing a command", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-engine-installation-"));
    roots.push(root);
    const executable = join(root, "mise", "installs", "codex", "0.160.0", "bin", "codex");
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, "binary");
    const resolver = new EngineInstallationResolver({
      environment: { PATH: "" },
      run: async () => result("codex-cli 0.160.0"),
    });
    const resolved = await resolver.resolve(executable, codex, "ambient");
    expect(resolved.plan).toBeUndefined();
    expect(resolved.descriptor).toMatchObject({
      detail: "Update this engine with mise.",
      update: "manual",
    });
  });

  it("recognizes a bounded Muse launcher from pure data and reads its channel manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-engine-installation-"));
    roots.push(root);
    const executable = join(root, "muse");
    await writeFile(executable, "muse-code/launcher- MUSE_SYNC_UPDATE");
    const resolver = new EngineInstallationResolver({
      environment: { MUSE_CHANNEL: "canary", PATH: "" },
      fetchJson: async (url) => ({
        version: url.endsWith("muse-canary") ? "1.2.3-R4" : "1.2.3-R3",
      }),
      run: async () => result("1.2.3-R3"),
    });
    const resolved = await resolver.resolve(
      executable,
      {
        comparison: "revision",
        executableName: "Muse",
        latest: {
          channelEnvironment: "MUSE_CHANNEL",
          channels: { canary: "muse-canary", stable: "muse-stable" },
          defaultChannel: "stable",
          kind: "channel-manifest",
          url: "https://example.test/{channel}",
          versionField: "version",
        },
        minimumVersion: "1.0.0",
        native: {
          launcherFile: {
            contains: ["muse-code/launcher-", "MUSE_SYNC_UPDATE"],
            maxBytes: 128 * 1_024,
          },
          updateArgs: ["--version"],
        },
        updateEnvironment: {
          MUSE_NO_AUTO_UPDATE: "0",
          MUSE_SYNC_UPDATE: "1",
          MUSE_UPDATE_INTERVAL_SECONDS: "0",
        },
        version: { args: ["--version"], pattern: /(\d+\.\d+\.\d+-R\d+)/ },
      },
      "all",
    );
    expect(resolved.descriptor).toMatchObject({ latestVersion: "1.2.3-R4", update: "available" });
    expect(resolved.plan).toMatchObject({ args: ["--version"] });
    expect(resolved.plan?.environment).toMatchObject({
      MUSE_CHANNEL: "canary",
      MUSE_SYNC_UPDATE: "1",
    });
  });
});

describe("latest version parsing", () => {
  it("parses npm and both Homebrew shapes without treating latest as a version", () => {
    expect(parseNpmLatestVersion('"2.1.316"')).toBe("2.1.316");
    expect(
      parseBrewLatestVersion('{"formulae":[{"versions":{"stable":"0.166.0"}}]}', "formula"),
    ).toBe("0.166.0");
    expect(parseBrewLatestVersion('{"casks":[{"version":"1.2.3,abc"}]}', "cask")).toBe("1.2.3");
    expect(parseBrewLatestVersion('{"casks":[{"version":"latest"}]}', "cask")).toBeNull();
  });

  it("compares Muse revisions only when both versions have revisions", () => {
    expect(compareRevisionVersions("1.2.3-R2", "1.2.3-R10")).toBeLessThan(0);
    expect(compareRevisionVersions("1.2.3-R10", "1.2.4-R1")).toBeLessThan(0);
    expect(compareRevisionVersions("1.2.3-R10", "1.2.3")).toBe(0);
  });
});

function result(stdout: string) {
  return { code: 0, stderr: "", stdout };
}
