import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityHarnessDriver } from "./driver.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Antigravity on Windows", () => {
  it("reports itself unavailable, naming the missing release, without downloading anything", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-"));
    roots.push(directory);
    const context = {
      config: {},
      environment: { PATH: process.env.PATH ?? "" },
      providerState: {
        continuationKey: "test",
        kind: "isolated" as const,
        privateStateRoot: directory,
        providerHomeDirectory: join(directory, "profile"),
        store: { directory: join(directory, "store"), id: "test" },
      },
      runtimeBoundary: nativeUserHarnessRuntimeBoundary,
      signal: AbortSignal.timeout(5_000),
      sourceId: "google",
      workingDirectory: directory,
    };
    const cache = join(directory, "cache");
    const driver = new AntigravityHarnessDriver({
      nodeExecutable: process.execPath,
      runtimeCacheDirectory: cache,
    });

    await driver.prepare(context);

    await expect(driver.inspect(context)).resolves.toEqual({
      detail:
        "Google publishes no Windows release of Antigravity's agent server, so Antigravity is not available on this computer",
      status: "unavailable",
    });
    await expect(readdir(cache)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
