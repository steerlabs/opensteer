import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engineArtifactPackageVersion } from "./runtime-artifact.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture(manifest?: string): Promise<{ directory: string; executable: string }> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-artifact-"));
  directories.push(directory);
  const executable = join(directory, "dist", "bundle", "cli.js");
  await mkdir(join(directory, "dist", "bundle"), { recursive: true });
  await writeFile(executable, "must not execute");
  if (manifest !== undefined) await writeFile(join(directory, "package.json"), manifest);
  return { directory, executable };
}

describe("engine artifact package version", () => {
  it("reads the manifest above the real executable, including an unexported manifest", async () => {
    const target = await fixture(JSON.stringify({ name: "engine", version: "1.2.3", exports: {} }));
    const link = await fixture(JSON.stringify({ name: "engine", version: "9.9.9" }));
    await rm(link.executable);
    await symlink(target.executable, link.executable);
    await expect(engineArtifactPackageVersion(link.executable, /^engine$/u)).resolves.toBe("1.2.3");
  });

  it.each([
    ["missing", undefined],
    ["malformed", "{"],
    ["unversioned", '{"name":"engine"}'],
    ["wrong package", '{"name":"other","version":"1.2.3"}'],
  ])("rejects a %s manifest", async (_label, manifest) => {
    const { executable } = await fixture(manifest);
    await expect(engineArtifactPackageVersion(executable, /^engine$/u)).rejects.toThrow(
      /manifest/u,
    );
  });

  it("rejects missing files and directories before trusting an adjacent manifest", async () => {
    const { directory, executable } = await fixture('{"name":"engine","version":"1.2.3"}');
    await rm(executable);
    await expect(engineArtifactPackageVersion(executable, /^engine$/u)).rejects.toThrow();
    await expect(engineArtifactPackageVersion(directory, /^engine$/u)).rejects.toThrow(/file/u);
  });
});
