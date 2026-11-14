import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import sharp from "sharp";
import { ThreadIdSchema, UserIdSchema } from "@opensteer/core";
import { AssetService } from "./asset-service.js";

const owner = UserIdSchema.parse("usr_11111111-1111-4111-8111-111111111111");
const threadId = ThreadIdSchema.parse("thr_11111111-1111-4111-8111-111111111111");
let root: string;
let service: AssetService;
let app: ReturnType<typeof Fastify>;
let now = 100_000_000;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "opensteer-media-"));
  for (const name of ["host", "runner/images", "home"])
    await mkdir(path.join(root, name), { recursive: true });
  now = 100_000_000;
  service = new AssetService({
    authSecret: "test-secret",
    dataDirectory: path.join(root, "host"),
    runnerDataDirectory: path.join(root, "runner"),
    agentHome: async () => root,
    homeDirectory: path.join(root, "home"),
    owns: async (_, id) => id === owner,
    now: () => now,
  });
  app = Fastify({ routerOptions: { maxParamLength: 8192 } });
  service.register(app);
  await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } })
    .png()
    .toFile(path.join(root, "a.png"));
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
async function mint(
  source = path.join(root, "a.png"),
  variant: "original" | "preview" = "original",
) {
  return (await service.urls({ threadId, assets: [{ path: source, variant }] }, owner)).assets[0]!;
}
it("refuses non-owners before examining files", async () => {
  await expect(
    service.urls(
      { threadId, assets: [{ path: "a.png", variant: "original" }] },
      UserIdSchema.parse("usr_22222222-2222-4222-8222-222222222222"),
    ),
  ).rejects.toThrow("Thread not found");
});
it("resolves absolute, home, file URL and relative paths; refuses network authorities", async () => {
  await symlink(path.join(root, "a.png"), path.join(root, "home/a.png"));
  const expected = await mint();
  for (const source of [
    "a.png",
    "~/a.png",
    pathToFileURL(path.join(root, "a.png")).href,
    pathToFileURL(path.join(root, "a.png")).href.replace("file:///", "file://localhost/"),
  ])
    expect(await mint(source)).toEqual(expected);
  for (const source of [
    "\\\\server\\a.png",
    "\\\\?\\UNC\\server\\a.png",
    "//server/a.png",
    "/\\server/a.png",
    "file://remote/a.png",
  ])
    expect(await mint(source)).toEqual({ status: "unavailable", reason: "denied" });
});
it("denies state and symlink escapes, exempting only validated Runner image store names", async () => {
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
    expect(await mint(path.join(root, name))).toEqual({ status: "unavailable", reason: "denied" });
  expect(await mint(path.join(root, `runner/images/${"a".repeat(64)}.png`))).toHaveProperty(
    "status",
    "ok",
  );
  await symlink(path.join(root, "host/a.png"), path.join(root, "escape.png"));
  expect(await mint(path.join(root, "escape.png"))).toHaveProperty("reason", "denied");
  await writeFile(path.join(root, "a.txt"), bytes);
  expect(await mint(path.join(root, "a.txt"))).toHaveProperty("reason", "unsupported");
  expect(await mint("absent.png")).toHaveProperty("reason", "missing");
});
it("canonicalizes symlinks and mints stable URLs; rejects replaced, expired and tampered capabilities", async () => {
  await symlink(path.join(root, "a.png"), path.join(root, "link.png"));
  const result = await mint();
  expect(await mint(path.join(root, "link.png"))).toEqual(result);
  if (result.status !== "ok") throw Error("Expected asset");
  expect((await app.inject(result.url)).statusCode).toBe(200);
  expect((await app.inject(result.url.replace("/media/", "/media/x"))).statusCode).toBe(404);
  now += 8 * 60 * 60 * 1000;
  expect((await app.inject(result.url)).statusCode).toBe(404);
  now -= 8 * 60 * 60 * 1000;
  await rename(path.join(root, "a.png"), path.join(root, "old.png"));
  await writeFile(path.join(root, "a.png"), "replacement");
  expect((await app.inject(result.url)).statusCode).toBe(404);
});
it("resizes lazily, reuses disk previews and passes animated GIF and SVG through", async () => {
  await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "red" } })
    .png()
    .toFile(path.join(root, "big.png"));
  const result = await mint(path.join(root, "big.png"), "preview");
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
    path.join(root, "a.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1000"/>',
  );
  const svg = await mint(path.join(root, "a.svg"), "preview");
  if (svg.status !== "ok") throw Error("Expected SVG");
  const svgResponse = await app.inject(svg.url);
  expect(svgResponse.headers["content-security-policy"]).toContain("sandbox");
  expect(svgResponse.headers["content-type"]).toBe("image/svg+xml");
  const frames = Buffer.concat([Buffer.alloc(1600 * 2 * 3, 0), Buffer.alloc(1600 * 2 * 3, 255)]);
  const animated = await sharp(frames, {
    raw: { width: 1600, height: 4, pageHeight: 2, channels: 3 },
  })
    .gif({ delay: [100, 100] })
    .toBuffer();
  expect((await sharp(animated).metadata()).pages).toBe(2);
  await writeFile(path.join(root, "animated.gif"), animated);
  const gif = await mint(path.join(root, "animated.gif"), "preview");
  if (gif.status !== "ok") throw Error("Expected GIF");
  expect(gif.mediaType).toBe("image/gif");
  expect(gif.url).toBe(((await mint(path.join(root, "animated.gif"))) as { url: string }).url);
  expect((await app.inject(gif.url)).rawPayload).toEqual(animated);
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
});
