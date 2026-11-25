import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { withTimeout } from "@opensteer/shared/withTimeout";
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

function createTarGz(
  entries: readonly {
    readonly content: Buffer | string;
    readonly name: string;
    readonly typeFlag?: string;
  }[],
): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data =
      typeof entry.content === "string" ? Buffer.from(entry.content, "utf8") : entry.content;
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, Math.min(100, Buffer.byteLength(entry.name)), "utf8");
    header.write("0000755\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${data.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = (entry.typeFlag ?? "0").charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += header[index]!;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header);
    if (data.byteLength > 0) {
      chunks.push(data);
      const remainder = data.byteLength % 512;
      if (remainder > 0) chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

function extractedOutputs() {
  return vi
    .mocked(createWriteStream)
    .mock.results.flatMap((result) => (result.type === "return" ? [result.value] : []));
}

async function unlockTree(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) await unlockTree(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
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
    temporaryDirectories.splice(0).map(async (directory) => {
      await unlockTree(directory);
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("Antigravity downloaded runtime", () => {
  it("verifies and atomically reuses one immutable digest-addressed release", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-runtime-"));
    temporaryDirectories.push(cacheDirectory);
    const archive = createTarGz([{ content: "executable", name: "antigravity" }]);
    const asset = {
      archive: {
        sha256: createHash("sha256").update(archive).digest("hex"),
        sha512: createHash("sha512").update(archive).digest("hex"),
        sizeBytes: archive.byteLength,
        url: "https://downloads.example/antigravity.tar.gz",
      },
      members: [{ name: "antigravity", sizeBytes: 10, type: "file" }],
    } as const;
    const request = vi.fn(async () => new Response(new Uint8Array(archive)));
    const validate = vi.fn(async (runtime: { readonly version: string }) => {
      expect(runtime.version).toBe("1.5.16");
      return { protocolVersion: 1 as const };
    });
    const options = {
      asset,
      cacheDirectory,
      fetch: request,
      signal: new AbortController().signal,
      validate,
      version: "1.5.16",
    };

    const first = await prepareAntigravityRuntimeRelease(options);
    const second = await prepareAntigravityRuntimeRelease(options);

    expect(first).toEqual(second);
    expect(first.directory).toBe(join(cacheDirectory, "antigravity", asset.archive.sha256));
    expect(first.executable).toBe(join(first.directory, "antigravity"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(await readdir(first.directory)).toEqual([
      ".opensteer-antigravity-release.json",
      "antigravity",
    ]);
    expect(await readFile(join(first.directory, "antigravity"), "utf8")).toBe("executable");
    expect((await stat(join(first.directory, "antigravity"))).mode & 0o777).toBe(0o555);
    expect((await stat(first.directory)).mode & 0o777).toBe(0o500);
    expect(
      JSON.parse(
        await readFile(join(first.directory, ".opensteer-antigravity-release.json"), "utf8"),
      ),
    ).toEqual({
      archiveSha256: asset.archive.sha256,
      protocolVersion: 1,
      version: "1.5.16",
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
            url: "https://downloads.example/antigravity.tar.gz",
          },
          members: [{ name: "antigravity", sizeBytes: 1, type: "file" }],
        },
        cacheDirectory,
        fetch: async () => new Response("bad"),
        signal: new AbortController().signal,
        validate: vi.fn(async () => ({ protocolVersion: 1 as const })),
        version: "1.5.16",
      }),
    ).rejects.toThrow("SHA-256");
  });

  it("refuses an archive member the manifest does not name and publishes nothing", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-runtime-"));
    temporaryDirectories.push(cacheDirectory);
    const archive = createTarGz([
      { content: "executable", name: "antigravity" },
      { content: "outside", name: "../escape" },
    ]);
    await expect(
      prepareAntigravityRuntimeRelease({
        asset: {
          archive: {
            sha256: createHash("sha256").update(archive).digest("hex"),
            sizeBytes: archive.byteLength,
            url: "https://downloads.example/antigravity.tar.gz",
          },
          members: [{ name: "antigravity", sizeBytes: 10, type: "file" }],
        },
        cacheDirectory,
        fetch: async () => new Response(new Uint8Array(archive)),
        signal: new AbortController().signal,
        validate: vi.fn(async () => ({ protocolVersion: 1 as const })),
        version: "1.5.16",
      }),
    ).rejects.toThrow("unexpected members");
    expect(extractedOutputs().length).toBeGreaterThan(0);
    expect(extractedOutputs().every((output) => output.closed)).toBe(true);
    expect(await readdir(join(cacheDirectory, "antigravity"))).toEqual([]);
    expect(await readdir(cacheDirectory)).toEqual(["antigravity"]);
  });

  it("refuses symlink archive entries", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-runtime-"));
    temporaryDirectories.push(cacheDirectory);
    const archive = createTarGz([{ content: "", name: "antigravity", typeFlag: "2" }]);
    await expect(
      prepareAntigravityRuntimeRelease({
        asset: {
          archive: {
            sha256: createHash("sha256").update(archive).digest("hex"),
            sizeBytes: archive.byteLength,
            url: "https://downloads.example/antigravity.tar.gz",
          },
          members: [{ name: "antigravity", sizeBytes: 0, type: "file" }],
        },
        cacheDirectory,
        fetch: async () => new Response(new Uint8Array(archive)),
        signal: new AbortController().signal,
        validate: vi.fn(async () => ({ protocolVersion: 1 as const })),
        version: "1.5.16",
      }),
    ).rejects.toThrow("unexpected members");
  });

  it("refuses PAX path overrides and truncated tar archives without two zero blocks", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-runtime-"));
    temporaryDirectories.push(cacheDirectory);
    const paxRecord = "20 path=antigravity\n";
    const paxArchive = createTarGz([
      { content: paxRecord, name: "PaxHeader", typeFlag: "x" },
      { content: "executable", name: "antigravity" },
    ]);
    await expect(
      prepareAntigravityRuntimeRelease({
        asset: {
          archive: {
            sha256: createHash("sha256").update(paxArchive).digest("hex"),
            sizeBytes: paxArchive.byteLength,
            url: "https://downloads.example/antigravity.tar.gz",
          },
          members: [{ name: "antigravity", sizeBytes: 10, type: "file" }],
        },
        cacheDirectory,
        fetch: async () => new Response(new Uint8Array(paxArchive)),
        signal: new AbortController().signal,
        validate: vi.fn(async () => ({ protocolVersion: 1 as const })),
        version: "1.5.16",
      }),
    ).rejects.toThrow("unsupported PAX overrides");

    // Archive missing the two-block zero terminator.
    const header = Buffer.alloc(512, 0);
    header.write("antigravity", 0, 11, "utf8");
    header.write("0000755\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write("00000000012\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += header[index]!;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    const body = Buffer.alloc(512, 0);
    body.write("executable", 0, 10, "utf8");
    const truncated = gzipSync(Buffer.concat([header, body]));
    await expect(
      prepareAntigravityRuntimeRelease({
        asset: {
          archive: {
            sha256: createHash("sha256").update(truncated).digest("hex"),
            sizeBytes: truncated.byteLength,
            url: "https://downloads.example/antigravity.tar.gz",
          },
          members: [{ name: "antigravity", sizeBytes: 10, type: "file" }],
        },
        cacheDirectory,
        fetch: async () => new Response(new Uint8Array(truncated)),
        signal: new AbortController().signal,
        validate: vi.fn(async () => ({ protocolVersion: 1 as const })),
        version: "1.5.16",
      }),
    ).rejects.toThrow("ended unexpectedly");
  });

  it.each(["abort", "corrupt gzip"] as const)(
    "closes every output before removing staging after %s during extraction",
    async (failure) => {
      const cacheDirectory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-runtime-"));
      temporaryDirectories.push(cacheDirectory);
      const member = Buffer.alloc(512 * 1024, 65);
      const archive = createTarGz([{ content: member, name: "antigravity" }]);
      const controller = new AbortController();
      const abortReason = new Error("Extraction cancelled");
      let abortedMidMember = false;
      if (failure === "abort") {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        vi.mocked(createReadStream).mockImplementationOnce((...args) => {
          const input = actual.createReadStream(...args);
          input.on("data", () => {
            if (!abortedMidMember) {
              abortedMidMember = true;
              controller.abort(abortReason);
            }
          });
          return input;
        });
      } else {
        // Corrupt the gzip payload bytes well after the header so streaming gunzip fails.
        archive[archive.byteLength - 20] = (archive[archive.byteLength - 20]! + 1) & 0xff;
        archive[archive.byteLength - 19] = (archive[archive.byteLength - 19]! + 1) & 0xff;
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
            url: "https://downloads.example/antigravity.tar.gz",
          },
          members: [{ name: "antigravity", sizeBytes: member.byteLength, type: "file" }],
        },
        cacheDirectory,
        fetch: async () => new Response(new Uint8Array(archive)),
        signal: controller.signal,
        validate,
        version: "1.5.16",
      });
      if (failure === "abort") {
        await expect(preparation).rejects.toThrow();
        expect(abortedMidMember).toBe(true);
      } else {
        await expect(preparation).rejects.toThrow();
      }
      expect(outputsClosedAtCleanup.every(Boolean)).toBe(true);
      expect(extractedOutputs().every((output) => output.closed)).toBe(true);
      expect(validate).not.toHaveBeenCalled();
      expect(await readdir(join(cacheDirectory, "antigravity"))).toEqual([]);
    },
  );
});
