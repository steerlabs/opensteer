import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import sharp from "sharp";
import { createId, ThreadIdSchema, UserIdSchema } from "@opensteer/core";
import { fileURLToPath } from "node:url";
import { createHmac, randomBytes } from "node:crypto";
import { AgentHomeFiles } from "../threads/agent-home-files.js";
import { TranscriptFileAccess } from "../threads/transcript-file-access.js";
import type { AttachmentService } from "../attachments/attachment-service.js";
import { AssetService } from "./asset-service.js";

const owner = UserIdSchema.parse("usr_11111111-1111-4111-8111-111111111111");
const threadId = ThreadIdSchema.parse("thr_11111111-1111-4111-8111-111111111111");
let root: string;
let service: AssetService;
let app: ReturnType<typeof Fastify>;
let access: TranscriptFileAccess;
let home: AgentHomeFiles;
let sessionLive = true;
let threadLive = true;
const actor = { userId: owner, sessionId: "test-session" };
let now = 100_000_000;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "opensteer-media-"));
  for (const name of ["host", "runner/images", "home"])
    await mkdir(path.join(root, name), { recursive: true });
  now = 100_000_000;
  sessionLive = threadLive = true;
  const helperPath = fileURLToPath(
    new URL("../../../runner/native-fs-helper/opensteer-native-fs", import.meta.url),
  );
  home = new AgentHomeFiles({
    agentHome: async () => ({ computerId: createId("runner"), path: path.join(root, "home") }),
    helperPath,
  });
  access = new TranscriptFileAccess({
    home,
    attachments: {} as AttachmentService,
    imagesRoot: path.join(root, "runner/images"),
    helperPath,
    homeDirectory: path.join(root, "home"),
    admit: async ({ userId, threadId: id }) =>
      userId === owner && (id === null || (threadLive && id === threadId)),
    outputImages: async () => [],
    outputImage: async () => null,
  });
  service = new AssetService({
    authSecret: "test-secret",
    dataDirectory: path.join(root, "host"),
    deploymentId: createId("deployment"),
    access,
    authorizeMedia: async ({ sessionId, userId }) =>
      sessionLive && sessionId === actor.sessionId && userId === owner,
    now: () => now,
  });
  app = Fastify({ routerOptions: { maxParamLength: 8192 } });
  service.register(app);
  await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } })
    .png()
    .toFile(path.join(root, "home/a.png"));
});
afterEach(async () => {
  await app.close();
  access.close();
  home.close();
  await rm(root, { recursive: true, force: true });
});
async function mint(
  source = path.join(root, "home/a.png"),
  variant: "original" | "preview" = "original",
) {
  return (
    await service.urls(
      { threadId, assets: [{ source: { kind: "path", path: source }, variant }] },
      actor,
    )
  ).assets[0]!;
}
it("refuses non-owners before examining files", async () => {
  await expect(
    service.urls(
      { threadId, assets: [{ source: { kind: "path", path: "a.png" }, variant: "original" }] },
      { ...actor, userId: UserIdSchema.parse("usr_22222222-2222-4222-8222-222222222222") },
    ),
  ).rejects.toThrow("File unavailable");
});
it("resolves absolute, home, file URL and relative paths; refuses network authorities", async () => {
  const expected = await mint();
  for (const source of [
    "a.png",
    "./a.png",
    "~/a.png",
    pathToFileURL(path.join(root, "home/a.png")).href,
    pathToFileURL(path.join(root, "home/a.png")).href.replace("file:///", "file://localhost/"),
  ])
    expect(await mint(source)).toEqual(expected);
  // Apps from before `source` name paths directly, and stay inside the API window.
  expect(
    (await service.urls({ threadId, assets: [{ path: "a.png", variant: "original" }] }, actor))
      .assets[0],
  ).toEqual(expected);
  for (const source of [
    "\\\\server\\a.png",
    "\\\\?\\UNC\\server\\a.png",
    "//server/a.png",
    "/\\server/a.png",
    "file://remote/a.png",
  ])
    expect(await mint(source)).toEqual({ status: "unavailable", reason: "missing" });
});
it("denies outside-home files, symlinks and unproven Runner cache paths", async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  for (const name of [
    "host/a.png",
    "runner/a.png",
    "runner/images/not-a-hash.png",
    `runner/images/${"a".repeat(64)}.png`,
  ])
    await writeFile(path.join(root, name), bytes);
  for (const name of ["host/a.png", "runner/a.png", "runner/images/not-a-hash.png"])
    expect(await mint(path.join(root, name))).toEqual({ status: "unavailable", reason: "missing" });
  expect(await mint(path.join(root, `runner/images/${"a".repeat(64)}.png`))).toHaveProperty(
    "status",
    "unavailable",
  );
  await symlink(path.join(root, "host/a.png"), path.join(root, "home/escape.png"));
  expect(await mint(path.join(root, "home/escape.png"))).toHaveProperty("reason", "missing");
  await writeFile(path.join(root, "home/a.txt"), bytes);
  expect(await mint(path.join(root, "home/a.txt"))).toHaveProperty("reason", "unsupported");
  expect(await mint("absent.png")).toHaveProperty("reason", "missing");
});
it("refuses symlinks and mints stable URLs; rejects replaced, expired and tampered capabilities", async () => {
  await symlink(path.join(root, "home/a.png"), path.join(root, "home/link.png"));
  const result = await mint();
  expect(await mint(path.join(root, "home/link.png"))).toHaveProperty("status", "unavailable");
  expect(await mint()).toEqual(result);
  if (result.status !== "ok") throw Error("Expected asset");
  expect((await app.inject(result.url)).statusCode).toBe(200);
  expect((await app.inject(result.url.replace("/media/", "/media/x"))).statusCode).toBe(404);
  now += 8 * 60 * 60 * 1000;
  expect((await app.inject(result.url)).statusCode).toBe(404);
  now -= 8 * 60 * 60 * 1000;
  await rename(path.join(root, "home/a.png"), path.join(root, "old.png"));
  await writeFile(path.join(root, "home/a.png"), "replacement");
  expect((await app.inject(result.url)).statusCode).toBe(404);
});
it("bounds static WebP previews, reuses disk previews and preserves GIF/SVG originals", async () => {
  await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "red" } })
    .png()
    .toFile(path.join(root, "home/big.png"));
  const result = await mint(path.join(root, "home/big.png"), "preview");
  if (result.status !== "ok") throw Error("Expected asset");
  expect(result).toMatchObject({ width: 1280, height: 640, mediaType: "image/webp" });
  const response = await app.inject(result.url);
  expect(response.statusCode).toBe(200);
  expect(await sharp(response.rawPayload).metadata()).toMatchObject({
    width: 1280,
    height: 640,
    format: "webp",
  });
  const cache = path.join(
    root,
    "host/media-previews",
    (await readdir(path.join(root, "host/media-previews")))[0]!,
  );
  const before = await stat(cache);
  expect((await app.inject(result.url)).rawPayload).toEqual(response.rawPayload);
  expect((await stat(cache)).mtimeMs).toBe(before.mtimeMs);
  await writeFile(
    path.join(root, "home/a.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"/>',
  );
  const svg = await mint(path.join(root, "home/a.svg"), "preview");
  expect(svg).toHaveProperty("status", "unavailable");
  const svgOriginal = await mint(path.join(root, "home/a.svg"), "original");
  if (svgOriginal.status !== "ok") throw Error("Expected SVG original");
  const svgResponse = await app.inject(svgOriginal.url);
  expect(svgResponse.headers["content-security-policy"]).toContain("sandbox");
  expect(svgResponse.headers["content-type"]).toBe("image/svg+xml");
  const frames = Buffer.concat([Buffer.alloc(1600 * 2 * 3, 0), Buffer.alloc(1600 * 2 * 3, 255)]);
  const animated = await sharp(frames, {
    raw: { width: 1600, height: 4, pageHeight: 2, channels: 3 },
  })
    .gif({ delay: [100, 100] })
    .toBuffer();
  expect((await sharp(animated).metadata()).pages).toBe(2);
  await writeFile(path.join(root, "home/animated.gif"), animated);
  const gif = await mint(path.join(root, "home/animated.gif"), "preview");
  if (gif.status !== "ok") throw Error("Expected GIF");
  expect(gif.mediaType).toBe("image/webp");
  const thumbnail = await app.inject(gif.url);
  expect(thumbnail.rawPayload.length).toBeLessThanOrEqual(512 * 1024);
  expect(await sharp(thumbnail.rawPayload).metadata()).toMatchObject({
    format: "webp",
    width: 1280,
  });
  expect((await sharp(thumbnail.rawPayload).metadata()).pages ?? 1).toBe(1);
  const original = await mint(path.join(root, "home/animated.gif"), "original");
  if (original.status !== "ok") throw Error("Expected GIF original");
  expect(original.mediaType).toBe("image/gif");
  expect((await app.inject(original.url)).rawPayload).toEqual(animated);
});
it("keeps media capabilities out of request and error log output", async () => {
  await app.close();
  const logs: string[] = [];
  app = Fastify({
    routerOptions: { maxParamLength: 8192 },
    logger: {
      stream: {
        write: (line: string) => {
          logs.push(line);
        },
      },
    },
  });
  service.register(app);
  const result = await mint();
  if (result.status !== "ok") throw Error("Expected asset");
  expect((await app.inject(result.url)).statusCode).toBe(200);
  expect((await app.inject(result.url.replace("/media/", "/media/tamper"))).statusCode).toBe(404);
  expect(logs.join("\n")).not.toContain(result.url.split("/")[2]);
  expect(logs.join("\n")).not.toContain(root);
  expect(logs.join("\n")).not.toContain("revision");
});

it("rejects v1 claims and rechecks session, thread and revision even with a cached preview", async () => {
  const f = await mint(path.join(root, "home/a.png"), "preview");
  if (f.status !== "ok") throw Error("Expected preview");
  expect(Date.parse(f.expiresAt) - now).toBeLessThanOrEqual(10 * 60 * 1000);
  expect((await app.inject(f.url)).statusCode).toBe(200);
  sessionLive = false;
  expect((await app.inject(f.url)).statusCode).toBe(404);
  sessionLive = true;
  threadLive = false;
  expect((await app.inject(f.url)).statusCode).toBe(404);
  threadLive = true;
  const payload = Buffer.from(
    JSON.stringify({ v: 1, path: path.join(root, "home/a.png"), exp: now + 60000 }),
  ).toString("base64url");
  const key = createHmac("sha256", "test-secret").update("opensteer-local-media-v1").digest();
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  expect((await app.inject(`/media/${payload}.${signature}/a.png`)).statusCode).toBe(404);
  const v2key = createHmac("sha256", "test-secret").update("opensteer-local-media-v2").digest();
  const v2signature = createHmac("sha256", v2key).update(payload).digest("base64url");
  expect((await app.inject(`/media/${payload}.${v2signature}/a.png`)).statusCode).toBe(404);
  const saved = now;
  now = Date.parse(f.expiresAt) - 1;
  expect((await app.inject(f.url)).statusCode).toBe(200);
  now++;
  expect((await app.inject(f.url)).statusCode).toBe(404);
  now = saved;
  await writeFile(path.join(root, "home/a.png"), "changed");
  expect((await app.inject(f.url)).statusCode).toBe(404);
});

it("caps high-entropy previews and preserves literal percent filenames without a second decode", async () => {
  const p = path.join(root, "home/noise%20image.png");
  await sharp(randomBytes(1280 * 1280 * 3), { raw: { width: 1280, height: 1280, channels: 3 } })
    .png()
    .toFile(p);
  const image = await mint(p, "preview");
  if (image.status !== "ok") throw Error("Expected noisy preview");
  const response = await app.inject(image.url);
  expect(response.statusCode).toBe(200);
  expect(response.rawPayload.length).toBeLessThanOrEqual(512 * 1024);
  expect(await sharp(response.rawPayload).metadata()).toMatchObject({
    width: 1280,
    height: 1280,
    format: "webp",
  });
  expect(await mint(pathToFileURL(p).href, "preview")).toEqual(image);
  for (const source of [
    `file://${root}/home/../home/a.png`,
    `file://${root}/home/%2e%2e/home/a.png`,
  ])
    expect(await mint(source)).toHaveProperty("status", "unavailable");
});

it("preserves JPEG, WebP and AVIF originals and converts their previews to WebP", async () => {
  for (const format of ["jpeg", "webp", "avif"] as const) {
    const bytes = await sharp({ create: { width: 16, height: 8, channels: 3, background: "red" } })
      .toFormat(format)
      .toBuffer();
    const p = path.join(root, `home/format.${format}`);
    await writeFile(p, bytes);
    const original = await mint(p, "original");
    expect(original.status, format).toBe("ok");
    if (original.status !== "ok") throw Error("Expected original");
    expect((await app.inject(original.url)).rawPayload).toEqual(bytes);
    const preview = await mint(p, "preview");
    expect(preview).toMatchObject({ status: "ok", mediaType: "image/webp", width: 16, height: 8 });
  }
});
