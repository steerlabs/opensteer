import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHarnessConfigSchema } from "./config.js";
import { packagedCodexExecutable } from "./executable.js";
import {
  assertCodexFeatureBoundary,
  codexApprovedFeatures,
  codexFeatureBoundary,
  codexFeatureBoundaryArgument,
} from "./features.js";
import { CodexStdioClient } from "./process.js";

/**
 * Drives the packaged Codex itself, because every way this boundary fails is a
 * fact about a real release:
 *
 * - a release adds a feature, or turns one on by default, and a Run has it;
 * - the person's own configuration turns on a feature Opensteer never approved;
 * - the person's own configuration turns off a feature a Run relies on;
 * - another feature keeps one on that Opensteer asked to turn off;
 * - a feature name holds a dot, which a dotted `-c` path reads as a nested table;
 * - the table cannot be read, and the Run starts at Codex's own defaults.
 */
describe("packaged Codex feature boundary", () => {
  const directories: string[] = [];
  const launch = { arguments: [], executable: packagedCodexExecutable() };
  const config = CodexHarnessConfigSchema.parse({});

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function startCodex(appServerArgs: readonly string[]): Promise<CodexStdioClient> {
    const home = await mkdtemp(join(tmpdir(), "opensteer-codex-boundary-"));
    directories.push(home);
    await writeFile(
      join(home, "config.toml"),
      "[features]\nmemories = true\nplugins = true\nshell_snapshot = false\n",
    );
    const client = await CodexStdioClient.start({
      appServerArgs,
      config,
      cwd: home,
      environment: { CODEX_HOME: home, HOME: home, PATH: process.env.PATH ?? "" },
      launch,
      onFailure: () => undefined,
      onMethodMessage: () => undefined,
      signal: new AbortController().signal,
    });
    await client.request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: { name: "opensteer", title: "Opensteer", version: "0.0.0" },
    });
    await client.notify("initialized", {});
    return client;
  }

  it("runs with exactly the approved features on, whatever the person configured", async () => {
    const boundary = await codexFeatureBoundary(launch);
    const client = await startCodex(["-c", codexFeatureBoundaryArgument(boundary)]);
    try {
      await assertCodexFeatureBoundary(client, boundary, config.requestTimeoutMs);
      const listed = (await client.request("experimentalFeature/list", {})) as {
        data: { name: string; stage: string; enabled: boolean }[];
      };
      const enabled = listed.data
        .filter((feature) => feature.stage !== "removed" && feature.enabled)
        .map((feature) => feature.name)
        .sort();
      expect(enabled).toEqual(
        Object.keys(boundary)
          .filter((name) => codexApprovedFeatures.has(name))
          .sort(),
      );
      expect(enabled).toContain("shell_snapshot");
      expect(enabled).not.toContain("plugins");
    } finally {
      await client.close();
    }
  });

  it("refuses a Codex whose features were not bounded", async () => {
    const boundary = await codexFeatureBoundary(launch);
    const client = await startCodex([]);
    try {
      await expect(
        assertCodexFeatureBoundary(client, boundary, config.requestTimeoutMs),
      ).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("plugins") });
    } finally {
      await client.close();
    }
  });

  it("reports a missing executable instead of starting without a boundary", async () => {
    await expect(
      codexFeatureBoundary({ arguments: [], executable: join(tmpdir(), "missing-codex") }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
