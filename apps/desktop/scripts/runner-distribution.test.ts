import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { PersonalRuntimeReleaseManifest } from "../src/releases/personal-runtime-release.js";
import { packRunnerDistribution, runnerDistributionArtifacts } from "./runner-distribution.js";

const run = promisify(execFile);
const piScript = "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

/** The Personal bundle's shape, minus the digests the packer never reads. */
function manifest(
  overrides: Partial<PersonalRuntimeReleaseManifest> = {},
): PersonalRuntimeReleaseManifest {
  const files = [
    { mode: "data", path: "THIRD_PARTY_NOTICES.md" },
    { mode: "executable", path: "bin/browser-harness" },
    { mode: "executable", path: "bin/opensteer-channel-runtime" },
    { mode: "executable", path: "bin/opensteer-host" },
    { mode: "executable", path: "bin/opensteer-native-fs" },
    { mode: "executable", path: "bin/opensteer-runner" },
    { mode: "executable", path: "bin/opencode" },
    { mode: "executable", path: "codex/bin/codex" },
    { mode: "executable", path: "codex/bin/codex-code-mode-host" },
    { mode: "data", path: "codex/codex-package.json" },
    { mode: "executable", path: "codex/codex-path/rg" },
    { mode: "code", path: piScript },
    { mode: "data", path: "pi/node_modules/@earendil-works/pi-coding-agent/package.json" },
    { mode: "code", path: "pi/node_modules/jiti/lib/jiti.cjs" },
    { mode: "data", path: "agent-skills/plugin.json" },
    { mode: "data", path: "agent-skills/skills/opensteer-triggers/SKILL.md" },
    { mode: "executable", path: "node/bin/node" },
    { mode: "executable", path: "postgres/bin/postgres" },
    { mode: "code", path: "services/browser-harness.mjs" },
    { mode: "code", path: "services/channel-runtime.mjs" },
    { mode: "code", path: "services/host.mjs" },
    {
      mode: "code",
      path: "services/node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node",
    },
    { mode: "data", path: "services/node_modules/sharp/lib/index.js" },
    { mode: "data", path: "services/node_modules/sharp/package.json" },
    { mode: "code", path: "services/runner.mjs" },
    { mode: "data", path: "web/index.html" },
    { mode: "data", path: "web/opensteer-web.json" },
  ] as const;
  return {
    architecture: "arm64",
    assets: {
      agentSkills: "agent-skills",
      webDistribution: {
        directory: "web",
        hostVersion: "0.1.23",
        manifest: "web/opensteer-web.json",
      },
    },
    entrypoints: {
      browserHarness: "bin/browser-harness",
      channelRuntime: "bin/opensteer-channel-runtime",
      host: "bin/opensteer-host",
      initdb: "postgres/bin/initdb",
      nativeFsHelper: "bin/opensteer-native-fs",
      node: "node/bin/node",
      pgIsReady: "postgres/bin/pg_isready",
      postgres: "postgres/bin/postgres",
      runner: "bin/opensteer-runner",
    },
    files: files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
    harnesses: {
      codex: "codex/bin/codex",
      opencode: "bin/opencode",
      pi: piScript,
    },
    hostVersion: "0.1.23",
    operatingSystem: "linux",
    postgresMajor: 17,
    postgresVersion: "17.4.0",
    runnerVersion: "0.1.23",
    schemaVersion: 7,
    ...overrides,
  };
}

async function bundle(source: PersonalRuntimeReleaseManifest): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-runner-distribution-"));
  temporaryDirectories.push(directory);
  for (const file of source.files) {
    const filePath = path.join(directory, ...file.path.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${file.path}\n`, "utf8");
  }
  return directory;
}

describe("Runner distribution", () => {
  it("takes the Runner's own runtime and leaves the Host, PostgreSQL and messaging behind", () => {
    expect(runnerDistributionArtifacts(manifest()).map((artifact) => artifact.path)).toEqual([
      "THIRD_PARTY_NOTICES.md",
      "agent-skills/plugin.json",
      "agent-skills/skills/opensteer-triggers/SKILL.md",
      "bin/browser-harness",
      "bin/opencode",
      "bin/opensteer-native-fs",
      "bin/opensteer-runner",
      "codex/bin/codex",
      "codex/bin/codex-code-mode-host",
      "codex/codex-package.json",
      "codex/codex-path/rg",
      "node/bin/node",
      // A script runtime's whole package tree travels, exactly like a tree
      // runtime's directory: the entry script imports from beside itself.
      piScript,
      "pi/node_modules/@earendil-works/pi-coding-agent/package.json",
      "pi/node_modules/jiti/lib/jiti.cjs",
      "services/browser-harness.mjs",
      // The native image decoder the Runner fits engine images with.
      "services/node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node",
      "services/node_modules/sharp/lib/index.js",
      "services/node_modules/sharp/package.json",
      "services/runner.mjs",
    ]);
  });

  it("refuses a bundle that is missing something the Runner starts", () => {
    expect(() =>
      runnerDistributionArtifacts(
        manifest({
          files: manifest()
            .files.filter((file) => file.path !== "services/runner.mjs")
            .map((file) => ({ ...file })),
        }),
      ),
    ).toThrow(/services\/runner\.mjs/u);
  });

  it("refuses a bundle without the image decoder the Runner loads", () => {
    expect(() =>
      runnerDistributionArtifacts(
        manifest({
          files: manifest()
            .files.filter((file) => !file.path.startsWith("services/node_modules/"))
            .map((file) => ({ ...file })),
        }),
      ),
    ).toThrow(/services\/node_modules\/sharp/u);
  });

  it("packs a versioned archive holding the entrypoint, helper and skills", async () => {
    const source = manifest();
    const directory = await bundle(source);
    const outputDirectory = path.join(directory, "dist");

    const packed = await packRunnerDistribution({
      identity: { sourceRevision: "a".repeat(40), version: "0.1.23" },
      manifest: source,
      outputDirectory,
      source: directory,
    });

    expect(packed.artifactName).toBe("opensteer-runner-linux-arm64.tar.gz");
    expect(packed.sha256).toMatch(/^[a-f0-9]{64}$/u);
    const listed = (await run("tar", ["-tzf", packed.archivePath])).stdout
      .split("\n")
      .map((entry) => entry.replace(/^\.\//u, "").replace(/\/$/u, ""))
      .filter((entry) => entry.length > 0);
    expect(listed).toEqual(
      expect.arrayContaining([
        "bin/opensteer-runner",
        "bin/opensteer-native-fs",
        "codex/bin/codex",
        "codex/codex-path/rg",
        piScript,
        "node/bin/node",
        "services/browser-harness.mjs",
        "services/node_modules/sharp/package.json",
        "services/runner.mjs",
        "agent-skills/plugin.json",
        "agent-skills/skills/opensteer-triggers/SKILL.md",
        "runner-release.json",
      ]),
    );
    expect(listed).not.toContain("bin/opensteer-host");
    expect(listed).not.toContain("postgres/bin/postgres");
    expect(listed).not.toContain("web/index.html");

    const extracted = path.join(directory, "extracted");
    await mkdir(extracted, { recursive: true });
    await run("tar", ["-xzf", packed.archivePath, "-C", extracted]);
    expect(
      JSON.parse(await readFile(path.join(extracted, "runner-release.json"), "utf8")) as unknown,
    ).toMatchObject({
      architecture: "arm64",
      entrypoints: { runner: "bin/opensteer-runner" },
      harnesses: { codex: "codex/bin/codex", pi: piScript },
      operatingSystem: "linux",
      release: { sourceRevision: "a".repeat(40), version: "0.1.23" },
      schemaVersion: 2,
    });
  });
});
