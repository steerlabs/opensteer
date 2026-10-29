import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { createId, type UserId, type WorkspaceId } from "@opensteer/core";
import {
  AttachmentStore,
  createDatabase,
  migrateToLatest,
  OpensteerStore,
} from "@opensteer/database";
import { sql } from "kysely";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AttachmentService, RunAttachmentsTokenService } from "./attachment-service.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration.sequential("Host attachment originals", () => {
  const database = createDatabase({
    applicationName: "opensteer-attachment-originals-test",
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 3,
  });
  const store = new OpensteerStore(database);
  const attachments = new AttachmentStore(database);
  let directory: string;
  let service: AttachmentService;

  beforeAll(async () => {
    await migrateToLatest(database);
    directory = await mkdtemp(join(tmpdir(), "opensteer-attachments-"));
    service = new AttachmentService({
      dataDirectory: directory,
      store: attachments,
      runTokens: new RunAttachmentsTokenService({ authorizer: store, tokens: {} as never }),
    });
  });
  beforeEach(async () => {
    await sql`truncate table messages, runs, threads, harness_catalogs, harness_instances,
      runner_enrollments, workspaces, execution_environments, runners, deployments, users restart identity cascade`.execute(
      database,
    );
  });
  afterAll(async () => {
    await database.destroy();
    await rm(directory, { recursive: true, force: true });
  });

  async function fixture(suffix: string) {
    await store.ensureDeployment({
      canonicalOrigin: "https://test-host.invalid",
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      hostInstanceId: createId("hostInstance"),
    });
    const userId = await store.createUser(`Attachment uploader ${suffix}`);
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: `wsp_${suffix}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 100_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: userId,
      idempotencyKey: `attachment-workspace-${suffix}`,
      name: `Attachments ${suffix}`,
      status: "ready",
    });
    if (workspace.kind !== "main") throw new Error("Expected main workspace");
    return { userId, workspaceId: workspace.id };
  }

  it("stores and verifies exact binary bytes above the former 1 MiB text limit", async () => {
    const f = await fixture("large");
    const bytes = randomBytes(1_200_000);
    const reserved = await service.reserve({
      idempotencyKey: "large-upload",
      mediaType: "application/octet-stream",
      name: "dataset.bin",
      sizeBytes: bytes.length,
      uploaderId: f.userId,
      workspaceId: f.workspaceId,
    });
    const uploaded = await service.upload({
      attachmentId: reserved.id,
      userId: f.userId,
      body: (async function* () {
        yield bytes.subarray(0, 650_000);
        yield bytes.subarray(650_000);
      })(),
    });
    expect(uploaded).toMatchObject({
      id: reserved.id,
      sizeBytes: bytes.length,
      kind: "file",
      state: "ready",
    });
    expect((await service.contentForUser(reserved.id, f.userId)).bytes).toEqual(bytes);
    await expect(
      service.upload({
        attachmentId: reserved.id,
        userId: f.userId,
        body: (async function* () {
          yield randomBytes(bytes.length);
        })(),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await service.contentForUser(reserved.id, f.userId)).bytes).toEqual(bytes);
  });

  it("returns a conflict when concurrent workspaces reuse one uploader's upload key", async () => {
    const first = await fixture("cross-workspace-key");
    const second = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "wsp_cross-workspace-key-second",
      },
      capacityPolicy: {
        blockHardLimitBytes: 100_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: first.userId,
      idempotencyKey: "attachment-workspace-cross-workspace-key-second",
      name: "Other attachments",
      status: "ready",
    });
    const input = {
      idempotencyKey: "same-key",
      mediaType: "text/plain",
      name: "same.txt",
      sizeBytes: 4,
      uploaderId: first.userId,
    };
    // Both requests must complete the existing-key read before either insert commits.
    await sql
      .raw(
        `create function attachment_review_delay_insert() returns trigger language plpgsql as $$
      begin
        if NEW.idempotency_key = 'same-key' then perform pg_sleep(0.5); end if;
        return NEW;
      end
    $$`,
      )
      .execute(database);
    await sql
      .raw(
        `create trigger attachment_review_delay_insert before insert on attachments
      for each row execute function attachment_review_delay_insert()`,
      )
      .execute(database);
    let results: PromiseSettledResult<Awaited<ReturnType<AttachmentStore["reserve"]>>>[];
    try {
      results = await Promise.allSettled([
        attachments.reserve({ ...input, workspaceId: first.workspaceId }),
        attachments.reserve({ ...input, workspaceId: second.id }),
      ]);
    } finally {
      await sql.raw("drop trigger attachment_review_delay_insert on attachments").execute(database);
      await sql.raw("drop function attachment_review_delay_insert()").execute(database);
    }
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "conflict" } });
  });

  it("rejects invalid image bytes and leaves the reservation unready", async () => {
    const f = await fixture("invalid-image");
    const bytes = Buffer.from("not a PNG image");
    const reserved = await service.reserve({
      idempotencyKey: "invalid-image",
      mediaType: "image/png",
      name: "fake.png",
      sizeBytes: bytes.length,
      uploaderId: f.userId,
      workspaceId: f.workspaceId,
    });
    await expect(
      service.upload({
        attachmentId: reserved.id,
        userId: f.userId,
        body: (async function* () {
          yield bytes;
        })(),
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This image could not be read. It may be damaged or incomplete.",
    });
    expect((await attachments.get(reserved.id))?.state).toBe("uploading");
  });

  describe("image ingestion", () => {
    async function uploadImage(
      f: { readonly userId: UserId; readonly workspaceId: WorkspaceId },
      name: string,
      mediaType: string,
      bytes: Uint8Array,
    ) {
      const reserved = await service.reserve({
        idempotencyKey: `image-${name}`,
        mediaType,
        name,
        sizeBytes: bytes.byteLength,
        uploaderId: f.userId,
        workspaceId: f.workspaceId,
      });
      return service.upload({
        attachmentId: reserved.id,
        userId: f.userId,
        body: (async function* () {
          yield bytes;
        })(),
      });
    }

    function photo(width: number, height: number): Promise<Buffer> {
      // Smooth content keeps a phone-sized JPEG well inside the byte limit.
      return sharp({
        create: { width, height, channels: 3, background: { r: 80, g: 120, b: 170 } },
      })
        .jpeg({ quality: 85 })
        .toBuffer();
    }

    function solidPng(width: number, height: number): Promise<Buffer> {
      return sharp({
        create: { width, height, channels: 3, background: { r: 245, g: 245, b: 245 } },
        limitInputPixels: false,
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
    }

    /** A PNG that announces animation (`acTL` before the first `IDAT`), as APNG does. */
    function withAnimationControl(png: Buffer): Buffer {
      const ihdrEnd = 8 + 8 + 13 + 4;
      const data = Buffer.alloc(8);
      data.writeUInt32BE(2, 0);
      data.writeUInt32BE(0, 4);
      const type = Buffer.from("acTL", "latin1");
      const chunk = Buffer.alloc(12 + data.length);
      chunk.writeUInt32BE(data.length, 0);
      type.copy(chunk, 4);
      data.copy(chunk, 8);
      chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
      return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
    }

    it("refuses unsupported image types at reservation, before any bytes move", async () => {
      const f = await fixture("unsupported-types");
      for (const mediaType of [
        "image/heic",
        "image/heif",
        "image/gif",
        "image/avif",
        "image/tiff",
        "image/svg+xml",
        "image/jpg",
      ]) {
        await expect(
          service.reserve({
            idempotencyKey: `unsupported-${mediaType}`,
            mediaType,
            name: "photo",
            sizeBytes: 1_000,
            uploaderId: f.userId,
            workspaceId: f.workspaceId,
          }),
        ).rejects.toMatchObject({
          code: "conflict",
          message: `This image type (${mediaType}) is not supported. Use PNG, JPEG, or WebP.`,
        });
      }
    });

    it("accepts full-resolution photos and stores their upright dimensions", async () => {
      const f = await fixture("photos");
      const cases: readonly {
        readonly name: string;
        readonly mediaType: string;
        readonly bytes: Buffer;
        readonly width: number;
        readonly height: number;
      }[] = [
        // A default iPhone photo (24 MP) and a "50 MP" sensor's 8192×6144 output.
        {
          name: "iphone.jpg",
          mediaType: "image/jpeg",
          bytes: await photo(5712, 4284),
          width: 5712,
          height: 4284,
        },
        {
          name: "sensor.jpg",
          mediaType: "image/jpeg",
          bytes: await photo(8192, 6144),
          width: 8192,
          height: 6144,
        },
        // A portrait photo stored landscape with EXIF orientation 6 is shown upright.
        {
          name: "portrait.jpg",
          mediaType: "image/jpeg",
          bytes: await sharp({
            create: { width: 300, height: 200, channels: 3, background: "#c33" },
          })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer(),
          width: 200,
          height: 300,
        },
        {
          name: "cmyk.jpg",
          mediaType: "image/jpeg",
          bytes: await sharp({ create: { width: 40, height: 30, channels: 3, background: "#0a0" } })
            .toColourspace("cmyk")
            .jpeg()
            .toBuffer(),
          width: 40,
          height: 30,
        },
        {
          name: "deep.png",
          mediaType: "image/png",
          bytes: await sharp({
            create: { width: 40, height: 30, channels: 4, background: "#08f8" },
          })
            .toColourspace("rgb16")
            .png()
            .toBuffer(),
          width: 40,
          height: 30,
        },
        {
          name: "gray.png",
          mediaType: "image/png",
          bytes: await sharp({ create: { width: 40, height: 30, channels: 3, background: "#777" } })
            .grayscale()
            .png()
            .toBuffer(),
          width: 40,
          height: 30,
        },
        {
          name: "palette.png",
          mediaType: "image/png",
          bytes: await sharp({ create: { width: 40, height: 30, channels: 3, background: "#936" } })
            .png({ palette: true })
            .toBuffer(),
          width: 40,
          height: 30,
        },
        {
          name: "alpha.webp",
          mediaType: "image/webp",
          bytes: await sharp({
            create: { width: 40, height: 30, channels: 4, background: "#f008" },
          })
            .webp({ lossless: true })
            .toBuffer(),
          width: 40,
          height: 30,
        },
        {
          name: "dot.png",
          mediaType: "image/png",
          bytes: await solidPng(1, 1),
          width: 1,
          height: 1,
        },
        {
          name: "strip.png",
          mediaType: "image/png",
          bytes: await solidPng(100_000, 1),
          width: 100_000,
          height: 1,
        },
      ];
      for (const item of cases) {
        const uploaded = await uploadImage(f, item.name, item.mediaType, item.bytes);
        expect(uploaded, item.name).toMatchObject({
          height: item.height,
          kind: "image",
          mediaType: item.mediaType,
          state: "ready",
          width: item.width,
        });
      }
    });

    it("refuses images over the pixel limit from their header, naming the dimensions", async () => {
      const f = await fixture("oversized");
      await expect(
        uploadImage(f, "wide.png", "image/png", await solidPng(12_000, 9_000)),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "This image is 12000×9000 (108.0 MP). The limit is 100 MP.",
      });
      // A decompression bomb: 400 MP in a file of a few megabytes.
      await expect(
        uploadImage(f, "bomb.png", "image/png", await solidPng(20_000, 20_000)),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "This image is 20000×20000 (400.0 MP). The limit is 100 MP.",
      });
    });

    it("refuses bytes whose image format differs from their label", async () => {
      const f = await fixture("mislabeled");
      await expect(
        uploadImage(f, "screenshot.jpg", "image/jpeg", await solidPng(20, 10)),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "This file is labeled image/jpeg but contains image/png data.",
      });
      await expect(
        uploadImage(f, "photo.webp", "image/webp", await photo(20, 10)),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "This file is labeled image/webp but contains image/jpeg data.",
      });
    });

    it("refuses animated images instead of keeping one frame", async () => {
      const f = await fixture("animated");
      const red = await solidPng(32, 24);
      const blue = await sharp({
        create: { width: 32, height: 24, channels: 3, background: "#00f" },
      })
        .png()
        .toBuffer();
      const animated = "Animated images are not supported. Use a single-frame PNG, JPEG, or WebP.";
      await expect(
        uploadImage(
          f,
          "loop.webp",
          "image/webp",
          await sharp([red, blue], { join: { animated: true } })
            .webp()
            .toBuffer(),
        ),
      ).rejects.toMatchObject({ code: "conflict", message: animated });
      await expect(
        uploadImage(f, "loop.png", "image/png", withAnimationControl(red)),
      ).rejects.toMatchObject({ code: "conflict", message: animated });
    });

    it("refuses damaged and empty images", async () => {
      const f = await fixture("damaged");
      const damaged = "This image could not be read. It may be damaged or incomplete.";
      const noisy = sharp({
        create: {
          width: 800,
          height: 600,
          channels: 3,
          background: "#808080",
          noise: { type: "gaussian", mean: 128, sigma: 30 },
        },
      });
      const jpeg = await noisy.clone().jpeg().toBuffer();
      const png = await noisy.clone().png().toBuffer();
      for (const [name, mediaType, bytes] of [
        ["cut.jpg", "image/jpeg", jpeg.subarray(0, jpeg.length / 2)],
        ["cut.png", "image/png", png.subarray(0, png.length / 2)],
        ["empty.png", "image/png", Buffer.alloc(0)],
      ] as const) {
        await expect(uploadImage(f, name, mediaType, bytes), name).rejects.toMatchObject({
          code: "conflict",
          message: damaged,
        });
      }
    });
  });

  it("coordinates discard with a competing finalization", async () => {
    const f = await fixture("discard");
    const bytes = Buffer.from("hello");
    const reserved = await service.reserve({
      idempotencyKey: "discard-upload",
      mediaType: "text/plain",
      name: "hello.txt",
      sizeBytes: bytes.length,
      uploaderId: f.userId,
      workspaceId: f.workspaceId,
    });
    await Promise.allSettled([
      service.upload({
        attachmentId: reserved.id,
        userId: f.userId,
        body: (async function* () {
          yield bytes;
        })(),
      }),
      service.discard(reserved.id, f.userId),
    ]);
    const row = await attachments.get(reserved.id);
    expect(row === undefined || row.state === "ready").toBe(true);
    if (row?.state === "ready")
      expect((await service.contentForUser(reserved.id, f.userId)).bytes).toEqual(bytes);
  });

  it("removes aged canonical bytes left after a rolled-back finalize or deleted workspace", async () => {
    const orphanId = createId("attachment");
    const originalDirectory = join(directory, "attachments", "originals");
    await mkdir(originalDirectory, { recursive: true });
    const path = join(originalDirectory, orphanId);
    await writeFile(path, "orphan bytes");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await utimes(path, old, old);
    await service.collectGarbage();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
