import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAntigravityRuntimeRelease } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Antigravity downloaded runtime", () => {
  it("verifies and atomically reuses one immutable digest-addressed release", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-runtime-"));
    temporaryDirectories.push(cacheDirectory);
    const archive = Buffer.from(
      zipSync({
        "agy_acp_server.par": strToU8("executable"),
        localharness_external: [strToU8("harness"), { level: 0 }],
      }),
    );
    const asset = {
      archive: {
        sha256: createHash("sha256").update(archive).digest("hex"),
        sizeBytes: archive.byteLength,
        url: "https://downloads.example/antigravity.zip",
      },
      members: [
        { name: "agy_acp_server.par", sizeBytes: 10, type: "file" },
        { name: "localharness_external", sizeBytes: 7, type: "file" },
      ],
    } as const;
    const request = vi.fn(async () => new Response(archive));
    const validate = vi.fn(async (runtime: { readonly version: string }) => {
      expect(runtime.version).toBe("1.4.1");
      return { protocolVersion: 1 as const };
    });
    const options = {
      asset,
      cacheDirectory,
      fetch: request,
      signal: new AbortController().signal,
      validate,
      version: "1.4.1",
    };

    const first = await prepareAntigravityRuntimeRelease(options);
    const second = await prepareAntigravityRuntimeRelease(options);

    expect(first).toEqual(second);
    expect(first.directory).toBe(join(cacheDirectory, "antigravity", asset.archive.sha256));
    expect(request).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(await readdir(first.directory)).toEqual([
      ".opensteer-antigravity-release.json",
      "agy_acp_server.par",
      "localharness_external",
    ]);
    expect(await readFile(join(first.directory, "agy_acp_server.par"), "utf8")).toBe("executable");
    expect((await stat(join(first.directory, "localharness_external"))).mode & 0o777).toBe(0o755);
    expect(
      JSON.parse(
        await readFile(join(first.directory, ".opensteer-antigravity-release.json"), "utf8"),
      ),
    ).toEqual({
      archiveSha256: asset.archive.sha256,
      protocolVersion: 1,
      version: "1.4.1",
    });
  });

  it("rejects a response whose bytes do not match the manifest", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-runtime-"));
    temporaryDirectories.push(cacheDirectory);
    await expect(
      prepareAntigravityRuntimeRelease({
        asset: {
          archive: {
            sha256: "0".repeat(64),
            sizeBytes: 3,
            url: "https://downloads.example/antigravity.zip",
          },
          members: [
            { name: "agy_acp_server.par", sizeBytes: 1, type: "file" },
            { name: "localharness_external", sizeBytes: 1, type: "file" },
          ],
        },
        cacheDirectory,
        fetch: async () => new Response("bad"),
        signal: new AbortController().signal,
        validate: vi.fn(async () => ({ protocolVersion: 1 as const })),
        version: "1.4.1",
      }),
    ).rejects.toThrow("SHA-256");
  });

  it("refuses an archive member the manifest does not name and publishes nothing", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-runtime-"));
    temporaryDirectories.push(cacheDirectory);
    const archive = Buffer.from(
      zipSync({
        "agy_acp_server.par": strToU8("executable"),
        "../escape": strToU8("outside"),
        localharness_external: strToU8("harness"),
      }),
    );
    await expect(
      prepareAntigravityRuntimeRelease({
        asset: {
          archive: {
            sha256: createHash("sha256").update(archive).digest("hex"),
            sizeBytes: archive.byteLength,
            url: "https://downloads.example/antigravity.zip",
          },
          members: [
            { name: "agy_acp_server.par", sizeBytes: 10, type: "file" },
            { name: "localharness_external", sizeBytes: 7, type: "file" },
          ],
        },
        cacheDirectory,
        fetch: async () => new Response(archive),
        signal: new AbortController().signal,
        validate: vi.fn(async () => ({ protocolVersion: 1 as const })),
        version: "1.4.1",
      }),
    ).rejects.toThrow("unexpected members");
    expect(await readdir(join(cacheDirectory, "antigravity"))).toEqual([]);
    expect(await readdir(cacheDirectory)).toEqual(["antigravity"]);
  });
});
