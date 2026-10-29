import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  nativeImageBase64Budget,
  nativeImageNeedsPreparation,
  prepareNativeImage,
  type NativeImageLimits,
} from "./native-images.js";
import type { ResolvedAttachment } from "./types.js";

const limits: NativeImageLimits = {
  maxBytes: 3_932_160,
  maxEdge: 2_000,
  mediaTypes: ["image/png", "image/jpeg", "image/webp"],
};

describe("native image preparation", () => {
  let directory: string;
  let sequence = 0;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "opensteer-native-images-"));
  });
  afterAll(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function resolved(
    bytes: Buffer,
    mediaType: string,
    name = "image",
  ): Promise<ResolvedAttachment> {
    sequence += 1;
    const path = join(directory, `${sequence}-${name}`);
    await writeFile(path, bytes);
    return {
      attachment: {
        id: `att_${sequence}`,
        kind: "image",
        mediaType,
        name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.byteLength,
      },
      path,
    };
  }

  function smoothPhoto(width: number, height: number): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: { r: 80, g: 120, b: 170 } } })
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  function noisyPhoto(width: number, height: number, quality = 95): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: "#808080",
        noise: { type: "gaussian", mean: 128, sigma: 40 },
      },
    })
      .jpeg({ quality })
      .toBuffer();
  }

  it("returns the verified original unchanged when it already fits", async () => {
    const bytes = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "#39c" },
    })
      .png()
      .toBuffer();
    const image = await resolved(bytes, "image/png");
    expect(await nativeImageNeedsPreparation(image, limits)).toBe(false);
    const prepared = await prepareNativeImage(image, limits);
    expect(prepared).toMatchObject({ mediaType: "image/png", transformed: false });
    expect(prepared.bytes.equals(bytes)).toBe(true);
  });

  it("fits a full-resolution photo inside the longest edge without enlarging it", async () => {
    const image = await resolved(await smoothPhoto(5712, 4284), "image/jpeg", "IMG_8003.jpeg");
    expect(await nativeImageNeedsPreparation(image, limits)).toBe(true);
    const prepared = await prepareNativeImage(image, limits);
    const metadata = await sharp(prepared.bytes).metadata();
    expect(prepared).toMatchObject({ mediaType: "image/jpeg", transformed: true });
    expect([metadata.width, metadata.height]).toEqual([2000, 1500]);
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(limits.maxBytes);

    const small = await resolved(await smoothPhoto(300, 200), "image/jpeg");
    const kept = await prepareNativeImage(small, { ...limits, maxEdge: 4000 });
    expect(kept.transformed).toBe(false);
  });

  it("re-encodes an image over its byte budget until it fits", async () => {
    const image = await resolved(await noisyPhoto(1600, 1200), "image/jpeg");
    const budget = 300_000;
    expect(image.attachment.sizeBytes).toBeGreaterThan(budget);
    const prepared = await prepareNativeImage(image, { ...limits, maxBytes: budget });
    expect(prepared.transformed).toBe(true);
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(budget);
    const metadata = await sharp(prepared.bytes).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(1600);
  });

  it("delivers rotated photos upright with no orientation left to reinterpret", async () => {
    // Stored landscape: left half red, right half blue. EXIF 6 displays it
    // turned 90° clockwise, so the viewer sees red on top and blue below.
    const raw = Buffer.alloc(300 * 200 * 3);
    for (let y = 0; y < 200; y += 1)
      for (let x = 0; x < 300; x += 1)
        raw.set(x < 150 ? [220, 20, 20] : [20, 20, 220], (y * 300 + x) * 3);
    const bytes = await sharp(raw, { raw: { width: 300, height: 200, channels: 3 } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const image = await resolved(bytes, "image/jpeg");
    expect(await nativeImageNeedsPreparation(image, limits)).toBe(true);
    const prepared = await prepareNativeImage(image, limits);
    const metadata = await sharp(prepared.bytes).metadata();
    expect([metadata.width, metadata.height, metadata.orientation]).toEqual([200, 300, undefined]);
    const { data } = await sharp(prepared.bytes).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray((y * 200 + x) * 3, (y * 200 + x) * 3 + 3),
    ];
    expect(pixel(100, 40)[0]).toBeGreaterThan(150);
    expect(pixel(100, 260)[2]).toBeGreaterThan(150);
  });

  it("keeps transparency when a translucent image has to be resized", async () => {
    const bytes = await sharp({
      create: {
        width: 3000,
        height: 3000,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 1500, height: 3000, channels: 4, background: "#0c0f" },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer();
    const prepared = await prepareNativeImage(await resolved(bytes, "image/png"), limits);
    const metadata = await sharp(prepared.bytes).metadata();
    expect(metadata.hasAlpha).toBe(true);
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(2000);
    const { data, info } = await sharp(prepared.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(1900, 1000)).toBe(0);
    expect(alphaAt(100, 1000)).toBe(255);
  });

  it("brings a deep image inside the engine's decoder allocation", async () => {
    const bytes = await sharp({
      create: { width: 400, height: 300, channels: 4, background: "#08f8" },
    })
      .toColourspace("rgb16")
      .png()
      .toBuffer();
    const image = await resolved(bytes, "image/png");
    const decoderBound = {
      mediaTypes: limits.mediaTypes,
      maxBytes: 10_000_000,
      maxDecodedBytes: 400 * 300 * 4,
    };
    expect(await nativeImageNeedsPreparation(image, decoderBound)).toBe(true);
    const prepared = await prepareNativeImage(image, decoderBound);
    const metadata = await sharp(prepared.bytes).metadata();
    expect([metadata.width, metadata.height, metadata.depth]).toEqual([400, 300, "uchar"]);
    expect(
      await nativeImageNeedsPreparation(
        await resolved(await smoothPhoto(400, 300), "image/jpeg"),
        decoderBound,
      ),
    ).toBe(false);
  });

  it("converts CMYK photos to sRGB even when they are small", async () => {
    const bytes = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "#0a0" },
    })
      .toColourspace("cmyk")
      .jpeg()
      .toBuffer();
    const prepared = await prepareNativeImage(await resolved(bytes, "image/jpeg"), limits);
    expect(prepared.transformed).toBe(true);
    expect((await sharp(prepared.bytes).metadata()).space).toBe("srgb");
  });

  it("converts a format the engine does not read", async () => {
    const bytes = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "#963" },
    })
      .webp()
      .toBuffer();
    const prepared = await prepareNativeImage(await resolved(bytes, "image/webp"), {
      ...limits,
      mediaTypes: ["image/png", "image/jpeg"],
    });
    expect(["image/png", "image/jpeg"]).toContain(prepared.mediaType);
    expect(`image/${(await sharp(prepared.bytes).metadata()).format}`).toBe(prepared.mediaType);
  });

  it("keeps extreme aspect ratios valid", async () => {
    const bytes = await sharp({
      create: { width: 20_000, height: 10, channels: 3, background: "#222" },
    })
      .png()
      .toBuffer();
    const prepared = await prepareNativeImage(await resolved(bytes, "image/png"), limits);
    const metadata = await sharp(prepared.bytes).metadata();
    expect(metadata.width).toBe(2000);
    expect(metadata.height).toBeGreaterThanOrEqual(1);
  });

  it("drops photo metadata from prepared copies", async () => {
    const bytes = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: "#468" },
    })
      .jpeg()
      .withExif({ IFD0: { Artist: "Somebody", Copyright: "Private" } })
      .toBuffer();
    expect((await sharp(bytes).metadata()).exif).toBeDefined();
    const prepared = await prepareNativeImage(await resolved(bytes, "image/jpeg"), limits);
    expect((await sharp(prepared.bytes).metadata()).exif).toBeUndefined();
  });

  it("shares a base64 budget across a delivery exactly", async () => {
    // Each payload travels base64-encoded: four bytes for every three.
    expect(nativeImageBase64Budget({ count: 3, perImage: 5_242_880, total: 1_000 })).toBe(249);
    expect(nativeImageBase64Budget({ count: 1, perImage: 5_242_880, total: 25_165_824 })).toBe(
      3_932_160,
    );
    expect(nativeImageBase64Budget({ count: 2, perImage: 5_242_880, total: 30 })).toBe(9);
    expect(nativeImageBase64Budget({ count: 2, perImage: 5_242_880, total: -10 })).toBe(0);
    const images = await Promise.all(
      [0, 1, 2, 3].map(async () => resolved(await noisyPhoto(1200, 900), "image/jpeg")),
    );
    const total = 1_000_000;
    const budget = nativeImageBase64Budget({ count: images.length, perImage: total, total });
    const prepared = await Promise.all(
      images.map((image) => prepareNativeImage(image, { ...limits, maxBytes: budget })),
    );
    const base64 = prepared.reduce((sum, image) => sum + image.bytes.toString("base64").length, 0);
    expect(base64).toBeLessThanOrEqual(total);
  });

  it("keeps shrinking an image wider than a lossy format can hold", async () => {
    // 17000 px is past WebP's 16383 px; the EXIF mirror forces a copy for an
    // engine with no edge limit, and noise keeps lossless PNG over budget.
    // Four rows reach the same encoder limit without decoding a large photograph.
    const bytes = await sharp({
      create: {
        width: 17_000,
        height: 4,
        channels: 4,
        background: "#808080",
        noise: { type: "gaussian", mean: 128, sigma: 60 },
      },
    })
      .png()
      .withMetadata({ orientation: 2 })
      .toBuffer();
    const image = await resolved(bytes, "image/png", "banner.png");
    const decoderBound: NativeImageLimits = {
      maxBytes: 100_000,
      maxDecodedBytes: 512 * 1_024 * 1_024,
      mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    };
    expect(image.attachment.sizeBytes).toBeGreaterThan(decoderBound.maxBytes);
    expect(await nativeImageNeedsPreparation(image, decoderBound)).toBe(true);
    const prepared = await prepareNativeImage(image, decoderBound);
    const metadata = await sharp(prepared.bytes).metadata();
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(decoderBound.maxBytes);
    expect(metadata.width).toBeLessThanOrEqual(16_383);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.width).toBeGreaterThan(1_000);
  });

  it("keeps shrinking an image wider than JPEG can hold", async () => {
    // libjpeg-turbo encodes at most 65500 px a side; an opaque source over the
    // PNG budget reaches the JPEG ladder at full width first.
    const bytes = await sharp({
      create: {
        width: 65_501,
        height: 20,
        channels: 3,
        background: "#808080",
        noise: { type: "gaussian", mean: 128, sigma: 60 },
      },
    })
      .png()
      .withMetadata({ orientation: 2 })
      .toBuffer();
    const image = await resolved(bytes, "image/png", "strip.png");
    const decoderBound: NativeImageLimits = {
      maxBytes: 3_000_000,
      maxDecodedBytes: 512 * 1_024 * 1_024,
      mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    };
    const prepared = await prepareNativeImage(image, decoderBound);
    expect(prepared.bytes.byteLength).toBeLessThanOrEqual(3_000_000);
    expect((await sharp(prepared.bytes).metadata()).width).toBeLessThanOrEqual(65_500);
  });

  it("refuses definitively when no encoding can reach the budget", async () => {
    const image = await resolved(await noisyPhoto(2000, 1500), "image/jpeg", "holiday.jpg");
    await expect(prepareNativeImage(image, { ...limits, maxBytes: 100 })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("holiday.jpg"),
    });
  });

  it("refuses a cached file that changed after the Runner verified it", async () => {
    const bytes = await smoothPhoto(5000, 3000);
    const image = await resolved(bytes, "image/jpeg");
    await writeFile(image.path, await smoothPhoto(5000, 2999));
    await expect(prepareNativeImage(image, limits)).rejects.toMatchObject({ code: "conflict" });
  });
});
