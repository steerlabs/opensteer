import { describe, expect, it } from "vitest";
import { PluginPackageService, type PluginPackagesTokenService } from "./plugin-package-service.js";
describe("Run package authorization", () => {
  it("refuses any digest outside the frozen pinned set, including an empty set", async () => {
    const digest = "a".repeat(64);
    for (const pluginDigests of [[], ["b".repeat(64)]]) {
      const service = new PluginPackageService({
        snapshotDirectory: "/unused",
        tokens: {
          authenticate: async () => ({ pluginDigests }),
        } as unknown as PluginPackagesTokenService,
      });
      await expect(service.snapshot("token", digest)).rejects.toMatchObject({ code: "forbidden" });
    }
  });
});

it("serves the pinned immutable whole package, retaining sibling files and file modes", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readPluginSnapshot, pluginSnapshotDigest } = await import("@opensteer/agent-plugins");
  const root = await mkdtemp(join(tmpdir(), "package-service-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "sibling.sh"), "echo sibling", { mode: 0o700 });
    const files = await readPluginSnapshot(source);
    const digest = pluginSnapshotDigest(files);
    const { rename } = await import("node:fs/promises");
    await rename(source, join(root, digest));
    const service = new PluginPackageService({
      snapshotDirectory: root,
      tokens: {
        authenticate: async () => ({ pluginDigests: [digest] }),
      } as unknown as PluginPackagesTokenService,
    });
    expect(await service.snapshot("run", digest)).toEqual([
      { path: "sibling.sh", mode: 0o700, content: Buffer.from("echo sibling").toString("base64") },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
