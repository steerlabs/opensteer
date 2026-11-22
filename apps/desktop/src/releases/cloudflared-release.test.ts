import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  packagedCloudflaredOrRefuse,
  readPackagedCloudflaredRelease,
  RemoteAccessHelperUnavailableError,
} from "./cloudflared-release.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("packaged cloudflared release", () => {
  it("fails closed when the Desktop release does not contain cloudflared", async () => {
    const resourcesDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-cloudflared-missing-"));
    temporaryDirectories.push(resourcesDirectory);

    expect(() => readPackagedCloudflaredRelease(resourcesDirectory)).toThrow();
  });

  it("refuses a missing helper with the one sentence a person reads, keeping the cause for the log", async () => {
    const resourcesDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-cloudflared-missing-"));
    temporaryDirectories.push(resourcesDirectory);
    let refused: unknown;
    try {
      packagedCloudflaredOrRefuse(resourcesDirectory);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RemoteAccessHelperUnavailableError);
    expect((refused as Error).message).toBe(
      "Remote access can’t start because part of Opensteer is missing or damaged on this Mac. Reinstall Opensteer, then turn it on again.",
    );
    expect(String((refused as Error).cause)).toMatch(/cloudflared/u);
  });

  it("accepts only the pinned executable matching the signed manifest", async () => {
    const fixture = await releaseFixture();

    expect(readPackagedCloudflaredRelease(fixture.resourcesDirectory)).toEqual({
      binaryPath: fixture.binaryPath,
      version: "2026.8.0",
    });

    await chmod(fixture.binaryPath, 0o755);
    await writeFile(fixture.binaryPath, "tampered", { mode: 0o555 });
    expect(() => readPackagedCloudflaredRelease(fixture.resourcesDirectory)).toThrow(
      /signed release manifest/u,
    );
  });

  it("fails closed for an old build or a symlinked executable", async () => {
    const old = await releaseFixture({ version: "2025.3.9" });
    expect(() => readPackagedCloudflaredRelease(old.resourcesDirectory)).toThrow(
      /2025\.4\.0 or newer/u,
    );

    const linked = await releaseFixture();
    const target = path.join(linked.resourcesDirectory, "outside-cloudflared");
    await writeFile(target, "fixture-cloudflared", { mode: 0o555 });
    await rm(linked.binaryPath);
    await symlink(target, linked.binaryPath);
    expect(() => readPackagedCloudflaredRelease(linked.resourcesDirectory)).toThrow(
      /real regular file/u,
    );
  });
});

async function releaseFixture(
  input: { readonly version?: string } = {},
): Promise<{ readonly binaryPath: string; readonly resourcesDirectory: string }> {
  const resourcesDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-cloudflared-release-"));
  temporaryDirectories.push(resourcesDirectory);
  const directory = path.join(resourcesDirectory, "cloudflared");
  await mkdir(directory, { mode: 0o700 });
  const binaryPath = path.join(directory, "cloudflared");
  const binary = "fixture-cloudflared";
  await writeFile(binaryPath, binary, { mode: 0o555 });
  await chmod(binaryPath, 0o555);
  await writeFile(
    path.join(directory, "release.json"),
    JSON.stringify({
      architecture: arch() === "x64" ? "amd64" : arch(),
      binarySha256: createHash("sha256").update(binary).digest("hex"),
      operatingSystem: platform(),
      schemaVersion: 1,
      version: input.version ?? "2026.8.0",
    }),
    { mode: 0o444 },
  );
  return { binaryPath, resourcesDirectory };
}
