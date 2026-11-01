import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAntigravityRuntimeRelease } from "./runtime.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: vi.fn(actual.createReadStream),
    createWriteStream: vi.fn(actual.createWriteStream),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const temporaryDirectories: string[] = [];

function extractedOutputs() {
  return vi
    .mocked(createWriteStream)
    .mock.results.flatMap((result) => (result.type === "return" ? [result.value] : []));
}

afterEach(async () => {
  await withTimeout(
    Promise.all(
      extractedOutputs().map(
        (output) =>
          new Promise<void>((resolve) => {
            if (output.closed) return resolve();
            output.once("close", resolve);
            output.destroy();
          }),
      ),
    ),
    1_000,
    { timeoutError: () => new Error("Extracted test outputs did not close") },
  );
  vi.mocked(createWriteStream).mockClear();
  vi.mocked(createReadStream).mockReset();
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
    expect(extractedOutputs().length).toBeGreaterThan(0);
    expect(extractedOutputs().every((output) => output.closed)).toBe(true);
    expect(await readdir(join(cacheDirectory, "antigravity"))).toEqual([]);
    expect(await readdir(cacheDirectory)).toEqual(["antigravity"]);
  });

  it.each(["abort", "corrupt deflate"] as const)(
    "closes every output before removing staging after %s during extraction",
    async (failure) => {
      const cacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-runtime-"));
      temporaryDirectories.push(cacheDirectory);
      const member = new Uint8Array(512 * 1024).fill(65);
      const archive = Buffer.from(
        zipSync({
          "agy_acp_server.par": strToU8("executable"),
          localharness_external: [member, { level: failure === "abort" ? 0 : 6 }],
        }),
      );
      const controller = new AbortController();
      const abortReason = new Error("Extraction cancelled");
      let abortedMidMember = false;
      if (failure === "abort") {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        vi.mocked(createReadStream).mockImplementationOnce((...args) => {
          const input = actual.createReadStream(...args);
          input.on("data", () => {
            if (extractedOutputs().some((output) => !output.writableEnded)) {
              abortedMidMember = true;
              controller.abort(abortReason);
            }
          });
          return input;
        });
      } else {
        const secondHeader =
          30 + archive.readUInt16LE(26) + archive.readUInt16LE(28) + archive.readUInt32LE(18);
        const dataOffset =
          secondHeader +
          30 +
          archive.readUInt16LE(secondHeader + 26) +
          archive.readUInt16LE(secondHeader + 28);
        // BTYPE=3 is reserved and makes UnzipInflate report an ondata error.
        archive[dataOffset] = 0x07;
      }
      const validate = vi.fn(async () => ({ protocolVersion: 1 as const }));
      let outputsClosedAtCleanup: boolean[] = [];
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(rm).mockImplementationOnce((...args) => {
        outputsClosedAtCleanup = extractedOutputs().map((output) => output.closed);
        return actual.rm(...args);
      });
      const preparation = prepareAntigravityRuntimeRelease({
        asset: {
          archive: {
            sha256: createHash("sha256").update(archive).digest("hex"),
            sizeBytes: archive.byteLength,
            url: "https://downloads.example/antigravity.zip",
          },
          members: [
            { name: "agy_acp_server.par", sizeBytes: 10, type: "file" },
            { name: "localharness_external", sizeBytes: member.byteLength, type: "file" },
          ],
        },
        cacheDirectory,
        fetch: async () => new Response(archive),
        signal: controller.signal,
        validate,
        version: "1.4.1",
      });
      if (failure === "abort") {
        await expect(preparation).rejects.toMatchObject({ name: "AbortError", cause: abortReason });
        expect(abortedMidMember).toBe(true);
      } else {
        await expect(preparation).rejects.toThrow("invalid block type");
      }
      expect(outputsClosedAtCleanup).toEqual([true, true]);
      expect(extractedOutputs()).toHaveLength(2);
      expect(extractedOutputs().every((output) => output.closed)).toBe(true);
      expect(validate).not.toHaveBeenCalled();
      expect(await readdir(join(cacheDirectory, "antigravity"))).toEqual([]);
    },
  );
});
