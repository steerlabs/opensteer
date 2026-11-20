import { createHash } from "node:crypto";
import { mkdtemp, rm, stat as fileStat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { HostOutputImageStore } from "./host-output-images.js";

describe("HostOutputImageStore", () => {
  it("stores, deduplicates, stats and reads verified output images on Host disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-output-images-"));
    try {
      const store = new HostOutputImageStore(dir);
      const png = await sharp({ create: { background: "blue", channels: 3, height: 8, width: 12 } })
        .png()
        .toBuffer();
      const sha256 = createHash("sha256").update(png).digest("hex");
      const filename = `${sha256}.png`;

      expect(await store.has(sha256, "png")).toBe(false);
      expect(await store.stat(filename)).toBeNull();

      await store.store({
        extension: "png",
        mediaType: "image/png",
        sha256,
        sizeBytes: png.byteLength,
        stream: Readable.from([png]),
      });

      expect(await store.has(sha256, "png")).toBe(true);
      const original = await fileStat(join(store.directory, filename));
      await store.store({
        extension: "png",
        mediaType: "image/png",
        sha256,
        sizeBytes: png.byteLength,
        stream: Readable.from([png]),
      });
      expect((await fileStat(join(store.directory, filename))).ino).toBe(original.ino);
      const stat = await store.stat(filename);
      expect(stat).toMatchObject({
        name: filename,
        revision: expect.stringMatching(/^[\w-]{43}\.[\w-]{43}$/u),
        sizeBytes: png.byteLength,
      });

      const full = await store.read(filename, {
        expectedRevision: stat!.revision,
        full: true,
        maxBytes: 32 * 1024 * 1024,
      });
      expect(full.bytes).toEqual(png);
      expect(full.eof).toBe(true);

      const preview = await store.read(filename, {
        expectedRevision: stat!.revision,
        maxBytes: 16,
      });
      expect(preview.bytes.byteLength).toBe(16);
      expect(preview.eof).toBe(false);

      // Oversize full read fails with file-too-large.
      await expect(
        store.read(filename, {
          expectedRevision: stat!.revision,
          full: true,
          maxBytes: 16,
        }),
      ).rejects.toMatchObject({
        code: "resource_exhausted",
        reason: "file-too-large",
      });

      // Checksum tampering on disk is detected.
      await writeFile(join(store.directory, filename), Buffer.alloc(png.byteLength, 0));
      await expect(
        store.read(filename, {
          expectedRevision: stat!.revision,
          full: true,
          maxBytes: 32 * 1024 * 1024,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("refuses checksum mismatch and media-type spoofing on store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-output-images-bad-"));
    try {
      const store = new HostOutputImageStore(dir);
      const text = Buffer.from("not a png at all");
      const sha256 = createHash("sha256").update(text).digest("hex");

      await expect(
        store.store({
          extension: "png",
          mediaType: "image/png",
          sha256,
          sizeBytes: text.byteLength,
          stream: Readable.from([text]),
        }),
      ).rejects.toMatchObject({ code: "bad_request" });

      await expect(
        store.store({
          extension: "png",
          mediaType: "image/png",
          sha256: "0".repeat(64),
          sizeBytes: text.byteLength,
          stream: Readable.from([text]),
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
