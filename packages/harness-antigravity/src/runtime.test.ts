import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const archive = Buffer.from("pinned archive bytes");
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
    const extract = vi.fn(async (_archive: string, { dir }: { readonly dir: string }) => {
      await writeFile(join(dir, "agy_acp_server.par"), "executable");
      await writeFile(join(dir, "localharness_external"), "harness");
    });
    const validate = vi.fn(async (runtime: { readonly version: string }) => {
      expect(runtime.version).toBe("1.4.1");
      return { protocolVersion: 1 as const };
    });
    const options = {
      asset,
      cacheDirectory,
      extract,
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
    expect(extract).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(await readdir(first.directory)).toEqual([
      ".opensteer-antigravity-release.json",
      "agy_acp_server.par",
      "localharness_external",
    ]);
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
        extract: vi.fn(),
        fetch: async () => new Response("bad"),
        signal: new AbortController().signal,
        validate: vi.fn(async () => ({ protocolVersion: 1 as const })),
        version: "1.4.1",
      }),
    ).rejects.toThrow("SHA-256");
  });
});
